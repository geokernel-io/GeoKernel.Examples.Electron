"use strict";

// Live AI / classical DSM-to-DTM comparison support. The experimental pix_grad model runs through
// GeoKernel.AI's raster inference C ABI (GeoKernelAI_RunRasterInference) as an asynchronous koffi
// call, so Electron's main thread keeps pumping the maps and receives the tile progress; the
// classical estimate is the processing example's `estimate`. Both receive the same full DSM only:
// the reference is evaluation-only. Model package, full 1 km Zurich tile and projection support are
// acquired and SHA-256 verified against pinned manifests.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const koffi = require("koffi");
const ds = require("../dsm-to-dtm/dsm-support");
const tr = require("../dsm-to-dtm-processing/terrain-support");

const MODEL_ID = "davpergan-dtm-dsm-gan-pix-grad";
const MODEL_SHA256 = "e400e27f6afc75bcf4e1a61432ee9557529683903996dd953d3e8e3fcbe90eb6";
const MODEL_HINT = "Use the exact model ZIP or retry its public URL.";
const MAX_SUPPORT_CELLS = 262144;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const modelAssets = () => readJson(path.join(__dirname, "model-assets.json"));
const terrainAssets = () => readJson(path.join(__dirname, "terrain-assets.json"));

/** `--data-dir`, `--sample-archive`/`--sample-url` (support ZIP) and `--model-archive`/`--model-url`. */
function parseOptions(argv) {
  const options = ds.parseOptions(argv);
  options.modelArchive = options.modelUrl = null;
  const names = { "--model-archive": "modelArchive", "--model-url": "modelUrl" };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key) continue;
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${argv[i]}.`);
    options[key] = argv[++i];
  }
  return options;
}

// ----- GeoKernel.AI bridge ---------------------------------------------------------------------------
let ai = null;
function bridge() {
  if (ai) return ai;
  const binDir = ds.bindGdal().binDir;
  const library = koffi.load(path.join(binDir, process.platform === "win32" ? "GeoKernel.AI.dll" : "libGeoKernel.AI.so"));
  const Progress = koffi.proto("GeoKernelAIDsmProgress", "void", ["int", "int", "int", "str16", "void *"]);
  const free = library.func("GeoKernelAI_FreeString", "void", ["void *"]);
  const owned = koffi.disposable("str16", (pointer) => free(pointer));
  ai = {
    Progress,
    inspect: library.func("GeoKernelAI_InspectModelPackageJson", owned, ["str16"]),
    run: library.func("GeoKernelAI_RunRasterInference", owned, ["str16", koffi.pointer(Progress), "void *"]),
    error: library.func("GeoKernelAI_GetLastError", owned, []),
  };
  return ai;
}

function take(value) {
  if (value === null || value === undefined) throw new Error(bridge().error() || "GeoKernel AI operation failed.");
  return JSON.parse(value);
}

/** The synchronous wrapper would deadlock here: the SDK reports progress from its own worker thread
 *  while the caller waits, and koffi queues that callback to this (blocked) thread. */
function runInference(request, progress) {
  const b = bridge();
  const callback = koffi.register((completed, total, percent, message) => progress({ completed, total, percent, message: message ?? "" }), koffi.pointer(b.Progress));
  return new Promise((resolve, reject) => {
    b.run.async(JSON.stringify(request), callback, null, (error, value) => {
      koffi.unregister(callback);
      if (error) reject(error);
      else {
        try { resolve(take(value)); } catch (failure) { reject(failure); }
      }
    });
  });
}

// ----- acquisition ---------------------------------------------------------------------------------
/** Download (when needed) and verify the full 1 km DSM and reference by size and SHA-256. */
async function prepareTerrain(assets, options, token, progress) {
  const folder = path.join(options.dataRoot, assets.cache);
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ["dsm", "reference"]) {
    const asset = assets.sources[name], file = path.join(folder, asset.file);
    if (ds.hashFile(file) !== asset.sha256)
      await ds.download(asset.url, file, token, progress, 0, "Retry when the swisstopo download is reachable.", `Full 1 km ${name}: downloading...`);
    ds.checkCancel(token);
    if (fs.statSync(file).size !== asset.bytes || ds.hashFile(file) !== asset.sha256) throw new Error("Full terrain source failed size/SHA-256 verification.");
  }
  return folder;
}

/** Verified pinned model package folder (archive and every package file hash-checked). */
async function prepareModel(options, archive, token, progress) {
  return preparePackage(modelAssets(), options.dataRoot, archive || options.modelArchive, options.modelUrl, MODEL_ID, MODEL_SHA256, token,
    (percent, message) => progress(percent, `Model: ${message}`));
}

/** A verified pinned package with the expected manifest id and ONNX hash. */
async function preparePackage(assets, dataRoot, archive, url, id, sha256, token, progress) {
  const folder = await ds.prepareSample(assets, { dataRoot, sampleArchive: archive, sampleUrl: url }, token, progress, MODEL_HINT);
  ds.checkCancel(token);
  const inspection = take(bridge().inspect(folder));
  if (!inspection.valid || inspection.manifest?.id !== id || inspection.modelSha256 !== sha256)
    throw new Error(`Unexpected model package. ${(inspection.validationErrors || []).join(" ")}`.trim());
  return folder;
}

// ----- AI inference -------------------------------------------------------------------------------
function sameCrs(a, b) {
  const g = ds.bindGdal();
  const left = g.newSrs(null), right = g.newSrs(null);
  try { return g.fromUser(left, a) === 0 && g.fromUser(right, b) === 0 && g.same(left, right) !== 0; }
  finally { g.destroySrs(left); g.destroySrs(right); }
}

/**
 * pix_grad over the full DSM with the package tiling; the reference is not involved. Missing cells are
 * filled for input context only (four-neighbour DSM support) and inputs smaller than one tile are
 * edge-padded right/bottom, the package's padding mode, before the raster reaches the SDK. The source
 * mask is restored and the final DTM bounded above by the DSM; the blended raw output is retained.
 */
async function infer(dsm, model, overlap, threads, folder, token, progress) {
  const manifest = readJson(path.join(model, "geokernel-model.json"));
  if (manifest.modelSha256 !== MODEL_SHA256) throw new Error("This example requires the pinned pix_grad adaptation.");
  const tileW = manifest.tiling.width, tileH = manifest.tiling.height;
  const w = dsm.width, h = dsm.height, pw = Math.max(w, tileW), ph = Math.max(h, tileH);
  let filled = 0;
  for (const v of dsm.valid) if (!v) filled++;
  const padded = pw !== w || ph !== h;
  let source = dsm.path;
  if (filled || padded) {
    let z = dsm.z;
    if (filled) {
      progress(38, "Filling missing DSM context from DSM support only...");
      const nearest = await tr.supportMap(dsm.valid, w, h, tr.scheduler(token));
      z = new Float32Array(w * h);
      for (let i = 0; i < z.length; i++) z[i] = dsm.valid[i] ? dsm.z[i] : dsm.z[nearest[i]];
    }
    if (padded) {
      const grown = new Float32Array(pw * ph);
      for (let y = 0; y < ph; y++) {
        const row = Math.min(y, h - 1) * w;
        for (let x = 0; x < pw; x++) grown[y * pw + x] = z[row + Math.min(x, w - 1)];
      }
      z = grown;
    }
    source = tr.writeRaster({ ...dsm, width: pw, height: ph }, path.join(folder, "dsm-context.tif"), z, 6);
  }
  ds.checkCancel(token);
  const output = path.join(folder, "ai-inference.tif"), provenance = manifest.provenance || {};
  // The C ABI call has no cancellation hook; cancellation is checked when it returns.
  const result = await runInference({
    modelPackagePath: model, rasterPath: source, outputPath: output, outputMode: "floatBands", bands: [1], provider: "cpu",
    intraOpThreads: threads, interOpThreads: 1, tiling: { overlapX: overlap, overlapY: overlap }, modelRevision: provenance.revision || provenance.sourceUrl || "",
  }, (p) => progress(40 + Math.trunc(p.percent * 0.4), `AI tiles ${p.completed} / ${p.total} · ${p.message}`));
  ds.checkCancel(token);
  if (result.cancelled || result.width !== pw || result.height !== ph || result.bandCount !== 1 || result.dataType !== "Float32")
    throw new Error("AI result dimensions or numeric type do not match the source.");
  if (!dsm.transform.every((v, i) => v === result.geoTransform[i]) || !sameCrs(dsm.projection, result.projectionWkt || ""))
    throw new Error("AI inference changed the source grid or CRS.");
  const values = ds.readRaster(output).values;
  const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) raw.set(values.subarray(y * pw, y * pw + w), y * w);
  const dtm = Float32Array.from(raw);
  let clamped = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!dsm.valid[i]) { raw[i] = dtm[i] = tr.NODATA; continue; }
    if (!Number.isFinite(raw[i])) throw new Error("AI returned a nonfinite valid-source height.");
    if (dtm[i] > dsm.z[i]) { dtm[i] = dsm.z[i]; clamped++; }
  }
  return { raw, dtm, provenance: result.provenance || {}, tiles: result.processedTiles, contextFilled: filled, clamped, padded };
}

// ----- comparison ---------------------------------------------------------------------------------
/** Keep the selected settings but coarsen the working grid until it fits the support-cell cap. */
function effectiveParameters(dsm, parameters) {
  const p = { ...parameters };
  const cells = (size) => Math.ceil(size / Math.max(1, Math.round(p.working / dsm.pixel)));
  while (cells(dsm.width) * cells(dsm.height) > MAX_SUPPORT_CELLS) p.working += dsm.pixel;
  return p;
}

/** [column, row, width, height]: the shared Zurich crop, or the central 60% of a custom DSM. */
function comparisonWindow(scene) {
  const d = scene.dsm;
  if (scene.manifest?.standard_full_tile) return [200, 800, 500, 500];
  const left = Math.trunc(d.width / 5), top = Math.trunc(d.height / 5);
  return [left, top, d.width - 2 * left, d.height - 2 * top];
}

function cropExtent(scene) {
  const [x, y, w, h] = comparisonWindow(scene), t = scene.dsm.transform, p = scene.dsm.pixel;
  const left = t[0] + x * p, top = t[3] - y * p;
  return [left, top - h * p, left + w * p, top];
}

function areaScore(dsm, z, reference, [x0, y0, w, h]) {
  const s = { count: 0, rmse: 0, mae: 0, bias: 0 };
  if (!reference) return s;
  let squared = 0, absolute = 0, signed = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = y * dsm.width + x;
      if (!dsm.valid[i] || !reference.valid[i]) continue;
      const e = z[i] - reference.z[i];
      s.count++; squared += e * e; absolute += Math.abs(e); signed += e;
    }
  }
  if (s.count) { s.rmse = Math.sqrt(squared / s.count); s.mae = absolute / s.count; s.bias = signed / s.count; }
  return s;
}

function cutValues(values, width, [x0, y0, w, h]) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(values.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + w), y * w);
  return out;
}

function cutGrid(d, rect) {
  const [x0, y0, w, h] = rect, t = d.transform;
  return { ...d, width: w, height: h, transform: [t[0] + x0 * d.pixel, t[1], t[2], t[3] - y0 * d.pixel, t[4], t[5]] };
}

function evaluate(scene, result, archiveSha256) {
  const d = scene.dsm, rect = comparisonWindow(scene), heights = [result.classical.dtm, result.ai.dtm];
  const full = heights.map((z) => tr.score(d, z, scene.reference)), crop = heights.map((z) => areaScore(d, z, scene.reference, rect));
  const ref = scene.reference;
  const report = {
    schema_version: 1,
    method: "pix_grad_live_and_independent_native_classical",
    source_dsm: d.path,
    source_sha256: d.sha256,
    reference: ref ? ref.path : null,
    reference_sha256: ref ? ref.sha256 : null,
    reference_used_for_processing: false,
    classical_uses_ai: false,
    ai_uses_classical: false,
    model_archive_sha256: archiveSha256,
    model_sha256: result.modelManifest.modelSha256,
    model_manifest: result.modelManifest,
    sdk_inference: result.ai.provenance,
    ai: {
      overlap_pixels: result.overlap, cpu_threads: result.threads, processed_tiles: result.ai.tiles, context_filled_source_pixels: result.ai.contextFilled,
      context_fill: "four-neighbour DSM-only support propagation", small_input_edge_padding: result.ai.padded,
      upper_bound_clamped_pixels: result.ai.clamped, raw_output_retained: true,
    },
    classical: { method: tr.METHOD, parameters: tr.parametersJson(result.classical.parameters), summary: result.classical.summary },
    grid: { width: d.width, height: d.height, transform: d.transform, crs_wkt: d.projection },
    evaluation: {
      full: { classical: tr.scoreJson(full[0]), ai: tr.scoreJson(full[1]) },
      comparison_crop: { pixel_window: { column: rect[0], row: rect[1], width: rect[2], height: rect[3] }, classical: tr.scoreJson(crop[0]), ai: tr.scoreJson(crop[1]) },
    },
    source_manifest: scene.manifest,
    output_files: Object.fromEntries(Object.keys(result.files).map((name) => [name, name])),
    attribution: "Terrain sample: Federal Office of Topography swisstopo. Model weights: David Perez, Zenodo 7973800, CC BY 4.0; deterministic ONNX adaptation.",
    limits: "Experimental regional model; fixed development scene, not held-out benchmark. Metre heights, no vertical datum conversion. Source filename years differ.",
  };
  return { ...result, full, crop, report };
}

const rgb = async (d, file, bands) => ds.writeRgb(file, d.width, d.height, d.transform, d.projection, ...await bands);

/** Classical first, then an independent AI inference from the same full source DSM. */
async function compare(scene, model, parameters, overlap, threads, folder, archiveSha256, token, progress) {
  const d = scene.dsm;
  const classical = await tr.estimate(d, parameters, token, (p, text) => progress(Math.trunc(p * 0.35), `Classical: ${text}`));
  const aiHeight = await infer(d, model, overlap, threads, folder, token, progress);
  const result = { classical, ai: aiHeight, overlap, threads, model, modelManifest: readJson(path.join(model, "geokernel-model.json")), folder, maps: [[], []], files: {} };
  const numeric = (name, values, type = 6) => { ds.checkCancel(token); result.files[name] = tr.writeRaster(d, path.join(folder, name), values, type); };
  progress(82, "Writing native-resolution numeric results...");
  await new Promise(setImmediate);
  numeric("classical-dtm.tif", classical.dtm);
  numeric("ai-dtm.tif", aiHeight.dtm);
  numeric("ai-raw.tif", aiHeight.raw);
  numeric("classical-removed.tif", classical.removed);
  const removed = new Float32Array(d.width * d.height);
  for (let i = 0; i < removed.length; i++) removed[i] = d.valid[i] ? Math.max(0, Math.fround(d.z[i] - aiHeight.dtm[i])) : tr.NODATA;
  numeric("ai-removed.tif", removed);
  numeric("classical-qa.tif", classical.quality, 1);
  const terrains = [classical, { dtm: aiHeight.dtm, removed }];
  for (let method = 0; method < 2; method++) {
    for (let mode = 0; mode < 3; mode++) {
      progress(86 + method * 4 + mode, `Preparing ${method ? "AI" : "classical"} display...`);
      const bands = mode === 0 ? tr.relief(d, terrains[method].dtm, token) : tr.diagnostic(d, terrains[method], mode === 1 ? 0 : 2, scene.reference, token);
      result.maps[method][mode] = await rgb(d, path.join(folder, `view-${method}-${mode}.tif`), bands);
    }
  }
  progress(96, "Preparing the shared comparison crop and scores...");
  const rect = comparisonWindow(scene), cropped = cutGrid(d, rect);
  const crop = (name, values) => { result.files[name] = tr.writeRaster(cropped, path.join(folder, name), cutValues(values, d.width, rect), 6); };
  crop("comparison-dsm.tif", d.z);
  crop("comparison-classical.tif", classical.dtm);
  crop("comparison-ai.tif", aiHeight.dtm);
  if (scene.reference) crop("comparison-reference.tif", scene.reference.z);
  const scored = evaluate(scene, result, archiveSha256);
  ds.checkCancel(token);
  return scored;
}

/** New error maps, crop file and scores for a new evaluation reference; heights unchanged. */
async function attachReference(scene, result, folder, archiveSha256, token, progress) {
  const d = scene.dsm, maps = [[...result.maps[0]], [...result.maps[1]]], heights = [result.classical.dtm, result.ai.dtm];
  for (let method = 0; method < 2; method++) {
    progress(40 + method * 20, "Preparing reference error maps...");
    maps[method][2] = await rgb(d, path.join(folder, `reference-${method}.tif`), tr.diagnostic(d, { dtm: heights[method] }, 2, scene.reference, token));
  }
  const rect = comparisonWindow(scene);
  const files = { ...result.files, "comparison-reference.tif": tr.writeRaster(cutGrid(d, rect), path.join(folder, "comparison-reference.tif"), cutValues(scene.reference.z, d.width, rect), 6) };
  return evaluate(scene, { ...result, maps, files }, archiveSha256);
}

/** Stage every file plus comparison.json beside the target, then rename into a new unique folder. */
async function exportBundle(result, parent, token, progress, name = "dsm-dtm-ai", stagingPrefix = ".dsm-dtm-export-") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const target = path.join(parent, `${name}-${stamp}-${crypto.randomBytes(3).toString("hex")}`);
  const staging = fs.mkdtempSync(path.join(parent, stagingPrefix));
  try {
    const names = Object.keys(result.files);
    for (const [index, name] of names.entries()) {
      ds.checkCancel(token);
      progress(Math.trunc((index + 1) * 90 / names.length), `Saving ${name}`);
      await new Promise(setImmediate);
      tr.atomicCopy(result.files[name], path.join(staging, name), token);
    }
    tr.writeJson(path.join(staging, "comparison.json"), { ...result.report, output_files: Object.fromEntries(names.map((name) => [name, name])) });
    ds.checkCancel(token);
    if (fs.existsSync(target)) throw new Error("Cannot commit result directory: it already exists.");
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}

module.exports = {
  MODEL_ID, modelAssets, terrainAssets, parseOptions, prepareTerrain, prepareModel, preparePackage, runInference, sameCrs, infer, effectiveParameters,
  comparisonWindow, cropExtent, areaScore, cutValues, cutGrid, compare, attachReference, exportBundle,
};
