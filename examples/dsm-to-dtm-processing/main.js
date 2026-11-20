"use strict";

// DSM to DTM: live classical processing. Run the classical conversion
// (native-multiscale-morphological-tin-v1) on the input DSM, change parameters, inspect the
// newly generated terrain and export numeric GeoTIFFs. Three linked native GeoKernel 2D maps
// show the original DSM, the generated DTM and a selectable diagnostic map. The reference is
// evaluation-only. All native calls stay on Electron's main thread; long loops yield.
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const { BrowserWindow, dialog, ipcMain, screen } = require("electron");
const ds = require("../dsm-to-dtm/dsm-support");
const tr = require("./terrain-support");
const { Map2D, pump } = require("../dsm-to-dtm-profile/map2d");

const EVENT = { VISIBLE_EXTENT_CHANGED: 12, MAP_MOUSE_DOWN: 20, MAP_MOUSE_UP: 22 };
const TOOL = { pan: 0, box: 1 };
const PARKED = [-1e9, -1e9];
const DIAGNOSTIC_TITLES = ["REMOVED HEIGHT · DSM − DTM", "PROCESSING QUALITY · supports / edges", "REFERENCE ERROR · DTM − reference"];
const LEGENDS = [
  "Removed height: white 0 m → dark red ≥20 m. Display saturation only. NoData gray.",
  "Quality: teal retained source · pale interpolated · orange edge-sensitive · purple hull fallback · gray NoData. Full flag combinations are saved in QA GeoTIFF.",
  "Signed error: blue ≤−2 m · white 0 · red ≥+2 m. Shared fixed scale; numeric scores are not clipped.",
];
// Parameter ranges of the six controls (same as the Qt spin boxes).
const RANGES = { working: [0.25, 20], window: [4, 200], threshold: [0.05, 3], slope: [0, 0.5], terrain: [0, 2], retain: [0, 1] };

let window = null, maps = [], timer = null, temporary = null, events = [], rects = null;
let options = null, assets = null, token = { cancelled: true }, scene = null, run = null;
let busy = false, closeQueued = false, generation = 0, mode = 0, tool = TOOL.pan;
let probePoint = null, presses = [null, null, null], applied = [null, null, null];

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function status(message, extra = {}) {
  send("processing:status", { message, busy, hasScene: !!scene, hasRun: !!run, ...extra });
}

const g = (v) => String(Number(v.toFixed(3)));

// ----- jobs ---------------------------------------------------------------------------------
function nextFolder() {
  const folder = path.join(temporary, String(++generation));
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/** Run one job; on success apply its result, keeping the last completed state on failure. */
async function job(work, apply) {
  if (busy) return;
  token = { cancelled: false };
  const current = token;
  busy = true;
  status("Working...", { percent: 0 });
  const progress = (percent, message) => status(message, { percent });
  try {
    const result = await work(current, progress);
    ds.checkCancel(current);
    if (!window) return;
    apply(result);
    busy = false;
    status(result?.message ?? "Ready.");
  } catch (error) {
    busy = false;
    if (!window) return;
    const cancelled = error instanceof ds.Cancelled || current.cancelled;
    status(cancelled ? "Cancelled. Last completed source/result retained." : error.message);
    if (!closeQueued && !cancelled) dialog.showMessageBox(window, { type: "warning", title: "Operation failed", message: error.message });
  }
  if (closeQueued) setImmediate(() => window?.close());
}

async function loadScene(dsmPath, referencePath, manifest, folder, current, progress) {
  progress(5, "Reading source DSM...");
  await new Promise(setImmediate);
  const dsm = tr.readRaster(dsmPath, current);
  let reference = null;
  if (referencePath) {
    progress(30, "Reading evaluation-only reference...");
    await new Promise(setImmediate);
    reference = tr.readRaster(referencePath, current);
    tr.validateReference(dsm, reference);
  }
  progress(60, "Preparing original DSM relief...");
  const original = ds.writeRgb(path.join(folder, "original.tif"), dsm.width, dsm.height, dsm.transform, dsm.projection, ...await tr.relief(dsm, dsm.z, current));
  ds.checkCancel(current);
  return { scene: { dsm, reference, original, manifest }, run: null, message: "Source ready. Choose parameters and Run." };
}

function scored(nextScene, nextRun) {
  const { all, interior } = tr.evaluate(nextScene.dsm, nextRun.terrain, nextScene.reference);
  return { ...nextRun, all, interior, report: tr.report(nextScene.dsm, nextScene.reference, nextScene.manifest, nextRun.terrain, all, interior) };
}

function loadSample() {
  const folder = nextFolder();
  job(async (current, progress) => {
    progress(0, "Checking cached sample files...");
    const sample = await ds.prepareSample(assets, options, current, progress);
    ds.checkCancel(current);
    ds.configureRuntime(sample);
    const manifest = JSON.parse(fs.readFileSync(path.join(sample, "source-manifest.json"), "utf8"));
    return loadScene(path.join(sample, "dsm.tif"), path.join(sample, "dtm_reference.tif"), manifest, folder, current, progress);
  }, publish);
}

async function openDsm() {
  const result = await dialog.showOpenDialog(window, { title: "Open DSM: metre heights in projected metre CRS", properties: ["openFile"], filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
  if (result.canceled || !result.filePaths[0] || busy) return;
  const file = result.filePaths[0], folder = nextFolder();
  job((current, progress) => loadScene(file, null, {}, folder, current, progress), publish);
}

async function openReference() {
  if (!scene) return;
  const result = await dialog.showOpenDialog(window, { title: "Open aligned reference (evaluation only)", properties: ["openFile"], filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
  if (result.canceled || !result.filePaths[0] || busy || !scene) return;
  const file = result.filePaths[0], folder = nextFolder(), currentScene = scene, completed = run;
  job(async (current, progress) => {
    progress(10, "Reading evaluation-only reference...");
    await new Promise(setImmediate);
    const reference = tr.readRaster(file, current);
    tr.validateReference(currentScene.dsm, reference);
    const nextScene = { ...currentScene, reference };
    let nextRun = null;
    if (completed) {
      const diagnostics = [...completed.diagnostics], d = currentScene.dsm;
      diagnostics[2] = ds.writeRgb(path.join(folder, "reference-error.tif"), d.width, d.height, d.transform, d.projection, ...await tr.diagnostic(d, completed.terrain, 2, reference, current));
      nextRun = scored(nextScene, { ...completed, diagnostics });
    }
    return { scene: nextScene, run: nextRun, message: "Reference attached; processing heights unchanged." };
  }, publish);
}

function process_(values) {
  if (!scene) return;
  const parameters = {};
  for (const [key, [low, high]] of Object.entries(RANGES)) {
    const value = Number(values?.[key]);
    if (!Number.isFinite(value) || value < low || value > high) { status(`Parameter out of range: ${key}`); return; }
    parameters[key] = value;
  }
  const currentScene = scene, folder = nextFolder();
  job(async (current, progress) => {
    const d = currentScene.dsm;
    const terrain = await tr.estimate(d, parameters, current, progress);
    const rgb = async (name, bands) => ds.writeRgb(path.join(folder, name), d.width, d.height, d.transform, d.projection, ...await bands);
    const dtm = tr.writeRaster(d, path.join(folder, "dtm.tif"), terrain.dtm, 6);
    ds.checkCancel(current);
    const removed = tr.writeRaster(d, path.join(folder, "removed.tif"), terrain.removed, 6);
    ds.checkCancel(current);
    const quality = tr.writeRaster(d, path.join(folder, "quality.tif"), terrain.quality, 1);
    const display = await rgb("terrain-relief.tif", tr.relief(d, terrain.dtm, current));
    const diagnostics = [];
    for (const m of [0, 1, 2]) diagnostics.push(await rgb(`diagnostic-${m}.tif`, tr.diagnostic(d, terrain, m, currentScene.reference, current)));
    progress(96, "Scoring reference after processing...");
    const nextRun = scored(currentScene, { terrain, dtm, removed, quality, display, diagnostics });
    ds.checkCancel(current);
    return { scene: currentScene, run: nextRun, message: "Processing complete. Change parameters to run again, or save the result." };
  }, publish);
}

async function saveResult() {
  if (!scene || !run) return;
  const result = await dialog.showSaveDialog(window, { title: "Save DTM, removed heights, QA and JSON", defaultPath: "terrain-result.tif", filters: [{ name: "GeoTIFF", extensions: ["tif"] }] });
  if (result.canceled || !result.filePath || busy || !run) return;
  let target = result.filePath;
  if (!target.toLowerCase().endsWith(".tif")) target += ".tif";
  const stem = target.slice(0, -4), destinations = [target, `${stem}.removed.tif`, `${stem}.qa.tif`, `${stem}.json`];
  const sources = [scene.dsm.path, ...(scene.reference ? [scene.reference.path] : [])];
  if (destinations.some((d) => sources.some((s) => tr.sameFile(d, s)))) {
    dialog.showMessageBox(window, { type: "warning", title: "Cannot export", message: "Choose output names different from the source and reference." });
    return;
  }
  if (destinations.slice(1).some((d) => fs.existsSync(d))) {
    const answer = await dialog.showMessageBox(window, { type: "question", buttons: ["Replace", "Cancel"], defaultId: 1, cancelId: 1,
      title: "Replace existing result companions?", message: "Removed-height, QA or JSON companion files already exist. Replace the result set?" });
    if (answer.response !== 0) return;
  }
  const completed = run;
  job(async (current, progress) => {
    const saved = [];
    try {
      const files = [completed.dtm, completed.removed, completed.quality];
      for (let i = 0; i < 3; i++) {
        progress(i * 30, `Saving ${path.basename(destinations[i])}`);
        await new Promise(setImmediate);
        tr.atomicCopy(files[i], destinations[i], current);
        saved.push(destinations[i]);
      }
      ds.checkCancel(current);
      tr.writeJson(destinations[3], completed.report);
    } catch (error) {
      if (saved.length && !(error instanceof ds.Cancelled)) throw new Error(`${error.message}\nFiles already committed:\n${saved.join("\n")}`);
      throw error;
    }
    return { message: "Saved DTM, removed heights, QA flags and provenance JSON." };
  }, () => send("processing:state", "Saved DTM, removed heights, QA flags and provenance JSON."));
}

function cancel() {
  token.cancelled = true;
  status("Cancelling; completed result will be retained...");
}

// ----- publishing ---------------------------------------------------------------------------
function publish(outcome) {
  const changed = !scene || outcome.scene.dsm !== scene.dsm;
  scene = outcome.scene;
  run = outcome.run;
  if (changed) {
    replace(0, scene.original, "Original DSM");
    for (const map of maps.slice(1)) { map.clearLayers(); map.refresh(); }
    probePoint = null;
    drawProbe();
    send("processing:probe", "Click a map to inspect source heights.");
    applied = [null, null, null];
    setImmediate(fit);
  }
  if (run) {
    replace(1, run.display, "Processed DTM");
    showDiagnostic();
  }
  const d = scene.dsm, p = run?.terrain.parameters;
  const line = (name, s) => s.count
    ? `${name} (${s.count} px)\nRMSE ${s.rmse.toFixed(3)} m · MAE ${s.mae.toFixed(3)} m · bias ${s.bias.toFixed(3)} m`
    : `${name}: no common valid reference pixels`;
  send("processing:scene", {
    source: `${path.basename(d.path)}\n${d.width} × ${d.height} · ${g(d.pixel)} m cells\n${scene.reference ? "Aligned reference attached" : "No reference: heights can still be processed"}`,
    metrics: !run ? "No processing has run yet."
      : scene.reference ? `${line("All valid reference cells", run.all)}\n\n${line("Interior outside edge band", run.interior)}`
        : "No reference attached. Scores are unavailable; processing does not require a reference.",
    summary: !run ? "Source loaded. Run to generate a new terrain estimate."
      : `Last completed run · ${run.terrain.supports} supports · ${run.terrain.seconds.toFixed(2)} s · working ${g(run.terrain.working)} m · max window ${g(p.window)} m · ` +
        `base ${g(p.threshold)} m · slope ${g(p.slope)} · relief ${g(p.terrain)} · keep ${g(p.retain)} m\n` +
        `Edge band ${g(p.window * 0.5)} m · hull fallback ${run.terrain.summary.outside_hull_fallback_pixels} pixels · reference is evaluation-only.`,
    headings: run ? ["PROCESSED DTM · live native result", DIAGNOSTIC_TITLES[mode]] : ["PROCESSED DTM · Run to generate", "REMOVED HEIGHT · Run to generate"],
    legend: run ? LEGENDS[mode] : null,
    state: outcome.message,
  });
}

// ----- maps ---------------------------------------------------------------------------------
/** Swap a map's raster but keep its view; the empty map adopts the raster's CRS. */
function replace(pane, file, name) {
  const map = maps[pane];
  const extent = map.layerCount() ? map.getExtent() : null;
  map.clearLayers();
  map.addLayer(file, name);
  map.setTool(tool);
  if (extent) { map.setExtent(extent); applied[pane] = map.getExtent(); }
  map.refresh();
}

function fit() {
  if (!scene || !maps.length) return;
  const [x0, y0, x1, y1] = tr.extent(scene.dsm), pad = scene.dsm.pixel * 10;
  maps[0].setExtent({ xMin: x0 - pad, yMin: y0 - pad, xMax: x1 + pad, yMax: y1 + pad });
  syncFrom(0);
}

function syncFrom(side) {
  applied[side] = maps[side].getExtent();
  if (!applied[side]) return;
  maps.forEach((map, other) => {
    if (other === side) return;
    map.setExtent(applied[side]);
    applied[other] = map.getExtent();
  });
}

const same = (a, b) => a && b && ["xMin", "yMin", "xMax", "yMax"].every((k) => Math.abs(a[k] - b[k]) < 1e-9);

function showDiagnostic() {
  if (!run || !scene) return;
  if (mode === 2 && !scene.reference) {
    mode = 0;
    send("processing:mode", 0);
    status("Attach an aligned reference to show errors.");
  }
  replace(2, run.diagnostics[mode], DIAGNOSTIC_TITLES[mode]);
  send("processing:display", { headings: ["PROCESSED DTM · live native result", DIAGNOSTIC_TITLES[mode]], legend: LEGENDS[mode] });
}

/** The probed cell as an overlay point on every map. It is moved, never removed: removal is
 *  deferred to a Qt event loop this host never runs, so a removed point would reappear. */
function drawProbe() {
  const [x, y] = probePoint || PARKED;
  for (const map of maps) map.setOverlayPoint("probe", x, y, { pointColor: "#d73573", pointSize: 11, lineColor: "#ffffff", lineWidth: 2 });
}

function inspect(x, y) {
  if (!scene || busy) return;
  const d = scene.dsm, t = d.transform, cx = (x - t[0]) / d.pixel, cy = (t[3] - y) / d.pixel;
  if (!(cx >= 0 && cy >= 0 && cx < d.width && cy < d.height)) return;
  const col = Math.floor(cx), row = Math.floor(cy), i = row * d.width + col;
  let text = `Source pixel · ${col} / ${row}\n`;
  if (!d.valid[i]) text += "NoData";
  else {
    text += `DSM ${d.z[i].toFixed(2)} m`;
    if (run) text += `\nDTM ${run.terrain.dtm[i].toFixed(2)} m · removed ${run.terrain.removed[i].toFixed(2)} m\nQA bits: ${run.terrain.quality[i]}`;
    const reference = scene.reference;
    if (reference && reference.valid[i]) {
      text += `\nReference ${reference.z[i].toFixed(2)} m`;
      if (run) text += ` · error ${(run.terrain.dtm[i] - reference.z[i]).toFixed(3)} m`;
    }
  }
  send("processing:probe", text);
  probePoint = [t[0] + (col + 0.5) * d.pixel, t[3] - (row + 0.5) * d.pixel];
  drawProbe();
}

function handleEvents() {
  const queued = events;
  events = [];
  for (const { side, e } of queued) {
    if (!scene) continue;
    if (e.type === EVENT.VISIBLE_EXTENT_CHANGED) {
      if (!same(applied[side], maps[side].getExtent())) syncFrom(side);
    } else if (e.type === EVENT.MAP_MOUSE_DOWN && e.int2 === 1) {
      presses[side] = [e.screen.left, e.screen.top];
    } else if (e.type === EVENT.MAP_MOUSE_UP && e.int2 === 1) {
      const press = presses[side];
      presses[side] = null;
      if (press && tool === TOOL.pan && Math.abs(press[0] - e.screen.left) + Math.abs(press[1] - e.screen.top) <= 3) inspect(e.extent.xMin, e.extent.yMin);
    }
  }
}

function layout() {
  if (!window || !rects || !maps.length) return;
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  rects.forEach((rect, i) => maps[i].place(Math.round(rect.x * scale), Math.round(rect.y * scale), Math.round(rect.width * scale), Math.round(rect.height * scale)));
}

// ----- window -------------------------------------------------------------------------------
function action(name, value) {
  if (name === "layout" && Array.isArray(value) && value.length === 3) { rects = value; layout(); return; }
  if (name === "cancel") { cancel(); return; }
  if (busy) return;
  if (name === "sample") loadSample();
  else if (name === "open") openDsm();
  else if (name === "reference") openReference();
  else if (name === "run") process_(value);
  else if (name === "save") saveResult();
  else if (name === "mode" && [0, 1, 2].includes(value)) { mode = value; showDiagnostic(); }
  else if (name === "tool" && value in TOOL) { tool = TOOL[value]; for (const map of maps) map.setTool(tool); }
  else if (name === "zoom" && value === "in") maps[0].zoomIn(1.5);
  else if (name === "zoom" && value === "out") maps[0].zoomOut(1.5);
  else if (name === "zoom" && value === "full") fit();
}

async function start() {
  options = ds.parseOptions(process.argv.slice(3));
  assets = ds.readAssets();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-dsm-processing-"));
  window = new BrowserWindow({
    width: 1720, height: 960, minWidth: 1100, minHeight: 720,
    title: "DSM to DTM | Live classical processing — GeoKernel", backgroundColor: "#f2f6f8",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("processing:action", (event, name, value) => {
    if (!window || !maps.length || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try { action(name, value); } catch (error) { status(error.message); }
  });
  window.on("resize", layout);
  window.on("close", (event) => {
    if (busy) { event.preventDefault(); closeQueued = true; cancel(); return; }
    stop();
  });
  window.on("closed", () => { window = null; ipcMain.removeHandler("processing:action"); require("electron").app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  pump();
  const parent = koffi.decode(window.getNativeWindowHandle(), "void *");
  maps = [0, 1, 2].map((side) => new Map2D(parent, (e) => events.push({ side, e })));
  for (const map of maps) map.setTool(tool);
  layout();
  timer = setInterval(() => {
    if (!maps.length) return;
    pump();
    try { handleEvents(); } catch (error) { status(error.message); }
  }, 16);
  send("processing:init", { presets: tr.PRESETS, names: tr.PRESET_NAMES });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  token.cancelled = true;
  for (const map of maps) map.close();
  maps = [];
  scene = run = null;
  busy = false;
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = null;
}

module.exports = { start, stop };
