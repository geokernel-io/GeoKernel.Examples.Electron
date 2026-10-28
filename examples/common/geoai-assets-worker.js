"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { parentPort, workerData } = require("worker_threads");
const AdmZip = require("adm-zip");
const cancelled = new Int32Array(workerData.cancellation);
const check = () => { if (Atomics.load(cancelled, 0)) throw new Error("Cancelled."); };
const progress = (percent, message) => parentPort.postMessage({ percent, message });

async function hash(file) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) { check(); digest.update(chunk); }
  return digest.digest("hex");
}

function find(root, name) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in asset content.");
    return entry.isDirectory() ? find(target, name) : entry.name === name ? [target] : [];
  });
}

async function prepare(asset) {
  check();
  if (asset.kind === "vector-preview") return require("./geoai-vector").prepareVectorPreview(asset, check);
  if (asset.kind === "sam3-prompts") return require("./sam3-coordinates").toSource(asset);
  if (asset.kind === "prithvi-rgb") {
    return require("./geoai-raster").prepareFloodRgb(asset, check, progress);
  }
  if (asset.kind === "prue-rgb") {
    return require("./geoai-raster").prepareFieldsRgb(asset, check, progress);
  }
  if (asset.kind === "sen2sr-rgb") {
    return require("./geoai-raster").prepareSuperResolutionRgb(asset, check, progress);
  }
  const base = process.env.GEOKERNEL_EXAMPLES_DATA_DIR || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"), "GeoKernel", "Examples", "GeoAI");
  const root = path.join(base, asset.sha);
  await fs.promises.mkdir(root, { recursive: true });
  const archive = path.join(root, asset.archive === false ? path.basename(asset.required) : "download.zip");
  if (!fs.existsSync(archive) || await hash(archive) !== asset.sha) {
    const partial = path.join(root, crypto.randomUUID() + ".part");
    try {
      const controller = new AbortController();
      const watch = setInterval(() => { if (Atomics.load(cancelled, 0)) controller.abort(); }, 100);
      let file;
      try {
        const response = await fetch(asset.url, { signal: controller.signal, headers: { "User-Agent": "GeoKernel-GeoAI-Examples" } });
        if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
        file = await fs.promises.open(partial, "wx");
        const total = Number(response.headers.get("content-length") || 0);
        let received = 0;
        for await (const chunk of response.body) {
          check(); await file.writeFile(chunk); received += chunk.length;
          progress(total ? Math.floor(received * 100 / total) : 0, `Downloading ${path.basename(new URL(asset.url).pathname)}`);
        }
      } finally { clearInterval(watch); if (file) await file.close(); }
      check();
      if (await hash(partial) !== asset.sha) throw new Error("Asset SHA-256 mismatch.");
      await fs.promises.rename(partial, archive);
    } finally { await fs.promises.rm(partial, { force: true }); }
  }
  check();
  if (asset.archive === false) return archive;
  const content = path.join(root, "content");
  if (!fs.existsSync(content)) {
    const staging = path.join(root, "extract-" + crypto.randomUUID());
    await fs.promises.mkdir(staging);
    try {
      if (asset.streaming) {
        await require("./geoai-zip").extractZip(archive, staging, check, progress);
      } else {
      const zip = new AdmZip(archive);
      for (const entry of zip.getEntries()) {
        check();
        const target = path.resolve(staging, entry.entryName);
        const relative = path.relative(staging, target);
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("Unsafe ZIP path.");
        if (entry.isDirectory) await fs.promises.mkdir(target, { recursive: true });
        else {
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.writeFile(target, entry.getData(), { flag: "wx" });
        }
      }
      }
      check();
      try { await fs.promises.rename(staging, content); }
      catch (error) { if (!fs.existsSync(content)) throw error; }
    } finally { await fs.promises.rm(staging, { force: true, recursive: true }); }
  }
  const matches = find(content, asset.required);
  if (matches.length !== 1) throw new Error(`Expected one ${asset.required}, found ${matches.length}.`);
  return matches[0];
}

prepare(workerData.asset).then(result => parentPort.postMessage({ result }),
  error => parentPort.postMessage({ error: Atomics.load(cancelled, 0) ? "Cancelled." : error.message }));
