"use strict";

// DSM to DTM: live AI versus classical. Run the experimental pix_grad model through GeoKernel.AI,
// run the native classical filter independently on the same DSM, and compare the newly generated
// heights. Three linked native GeoKernel 2D maps keep the original DSM on the left. Neither method
// receives the reference or the other method's estimate. Map and GDAL calls stay on Electron's
// main thread (long loops yield); the inference itself is an asynchronous native call.
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const { BrowserWindow, dialog, ipcMain, screen } = require("electron");
const ds = require("../dsm-to-dtm/dsm-support");
const tr = require("../dsm-to-dtm-processing/terrain-support");
const ai = require("./ai-support");
const { Map2D, pump } = require("../dsm-to-dtm-profile/map2d");

const EVENT = { VISIBLE_EXTENT_CHANGED: 12, MAP_MOUSE_DOWN: 20, MAP_MOUSE_UP: 22 };
const TOOL = { pan: 0, box: 1 };
const PARKED = [-1e9, -1e9];
const SUFFIX = ["DTM · terrain relief", "REMOVED HEIGHT · DSM − DTM", "ERROR · DTM − reference"];
const LEGENDS = [
  "Identical relief light and contrast. Left: original DSM. Both estimates are independently computed from this full input.",
  "One shared removed-height scale: white 0 m → red ≥20 m. Display saturation only; numeric heights are not clipped.",
  "One shared signed-error scale: blue ≤−2 m · white 0 · red ≥+2 m. Scores use all common valid pixels in the selected scope.",
];

let window = null, maps = [], timer = null, temporary = null, events = [], rects = null;
let options = null, sampleAssets = null, terrainAssets = null, archiveSha256 = null, token = { cancelled: true };
let scene = null, comparison = null, model = null, setupModel = false;
let busy = false, closeQueued = false, generation = 0, mode = 0, scope = 0, tool = TOOL.pan;
let probePoint = null, presses = [null, null, null], applied = [null, null, null];

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function status(message, extra = {}) {
  send("ai:status", { message, busy, hasScene: !!scene, hasModel: !!model, hasComparison: !!comparison, ...extra });
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
    send("ai:state", result?.message ?? "Ready.");
  } catch (error) {
    busy = false;
    if (!window) return;
    const cancelled = error instanceof ds.Cancelled || current.cancelled;
    const message = cancelled ? "Cancelled; completed comparison retained." : error.message;
    status(message);
    send("ai:state", message);
    if (!closeQueued && !cancelled) dialog.showMessageBox(window, { type: "warning", title: "Unable to complete operation", message: error.message });
  }
  if (closeQueued) setImmediate(() => window?.close());
  else if (setupModel && scene && !model) { setupModel = false; setImmediate(() => prepareModel(null)); }
}

function prepareModel(archive) {
  job(async (current, progress) => {
    const folder = await ai.prepareModel(options, archive, current, progress);
    return { model: folder, message: scene ? "Source and model ready. Press Run AI + classical." : "Model ready; load a DSM." };
  }, (outcome) => {
    model = outcome.model;
    send("ai:model", "pix_grad ready · 256 × 256 tiles\nVerified ONNX · CPU · experimental");
  });
}

async function localModel() {
  const result = await dialog.showOpenDialog(window, { title: "Choose the pinned pix_grad model ZIP", properties: ["openFile"], filters: [{ name: "ZIP", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths[0] || busy) return;
  prepareModel(result.filePaths[0]);
}

async function loadScene(dsmPath, referencePath, manifest, folder, current, progress) {
  progress(5, "Reading source DSM...");
  await new Promise(setImmediate);
  const dsm = tr.readRaster(dsmPath, current);
  let reference = null;
  if (referencePath) {
    await new Promise(setImmediate);
    reference = tr.readRaster(referencePath, current);
    tr.validateReference(dsm, reference);
  }
  if (manifest.standard_full_tile) {
    const [x0, y0, x1, y1] = tr.extent(dsm);
    if (dsm.width !== 2000 || dsm.height !== 2000 || dsm.pixel !== 0.5 || x0 !== 2677000 || y0 !== 1251000 || x1 !== 2678000 || y1 !== 1252000)
      throw new Error("Unexpected full Zurich grid.");
  }
  progress(60, "Preparing original DSM display...");
  const original = ds.writeRgb(path.join(folder, "original.tif"), dsm.width, dsm.height, dsm.transform, dsm.projection, ...await tr.relief(dsm, dsm.z, current));
  ds.checkCancel(current);
  return { scene: { dsm, reference, original, manifest }, comparison: null, message: "Source ready. Prepare model and Run." };
}

function loadSample() {
  const folder = nextFolder();
  setupModel = !model;
  job(async (current, progress) => {
    const support = await ds.prepareSample(sampleAssets, options, current, (p, m) => progress(p, `Projection/sample support: ${m}`));
    ds.checkCancel(current);
    ds.configureRuntime(support);
    const terrain = await ai.prepareTerrain(terrainAssets, options, current, progress);
    return loadScene(path.join(terrain, "dsm.tif"), path.join(terrain, "reference.tif"), { ...terrainAssets, standard_full_tile: true }, folder, current, progress);
  }, publish);
}

async function openDsm() {
  const result = await dialog.showOpenDialog(window, { title: "Open metre-height DSM", properties: ["openFile"], filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
  if (result.canceled || !result.filePaths[0] || busy) return;
  const file = result.filePaths[0], folder = nextFolder();
  job((current, progress) => loadScene(file, null, {}, folder, current, progress), publish);
}

async function openReference() {
  if (!scene) return;
  const result = await dialog.showOpenDialog(window, { title: "Open aligned evaluation-only reference", properties: ["openFile"], filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
  if (result.canceled || !result.filePaths[0] || busy || !scene) return;
  const file = result.filePaths[0], folder = nextFolder(), currentScene = scene, completed = comparison;
  job(async (current, progress) => {
    progress(5, "Reading evaluation-only reference...");
    await new Promise(setImmediate);
    const reference = tr.readRaster(file, current);
    tr.validateReference(currentScene.dsm, reference);
    const nextScene = { ...currentScene, reference };
    const updated = completed ? await ai.attachReference(nextScene, completed, folder, archiveSha256, current, progress) : null;
    ds.checkCancel(current);
    return { scene: nextScene, comparison: updated, message: "Reference updated. Both generated height arrays are unchanged." };
  }, publish);
}

function process_(values) {
  if (!scene || !model) return;
  const overlap = Number(values?.overlap), threads = Number(values?.threads), preset = Number(values?.preset);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > 128) { status("Tile overlap must be a whole number from 0 to 128 px."); return; }
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) { status("CPU threads must be a whole number from 1 to 8."); return; }
  if (![0, 1, 2].includes(preset)) return;
  const currentScene = scene, package_ = model, folder = nextFolder();
  const parameters = ai.effectiveParameters(currentScene.dsm, tr.PRESETS[preset]);
  job(async (current, progress) => {
    const result = await ai.compare(currentScene, package_, parameters, overlap, threads, folder, archiveSha256, current, progress);
    return { scene: currentScene, comparison: result, message: "Both methods completed from the same full DSM." };
  }, publish);
}

async function exportResults() {
  if (!comparison) return;
  const result = await dialog.showOpenDialog(window, { title: "Choose parent folder for a new result bundle", properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0] || busy || !comparison) return;
  const parent = result.filePaths[0], completed = comparison;
  job(async (current, progress) => {
    const target = await ai.exportBundle(completed, parent, current, progress);
    return { message: `Saved complete comparison bundle: ${target}` };
  }, () => {});
}

function cancel() {
  token.cancelled = true;
  status("Cancelling; completed comparison retained...");
}

// ----- publishing ---------------------------------------------------------------------------
function scores() {
  if (!comparison) return { rows: null, summary: "No terrain conversion has run for this input." };
  const values = scope ? comparison.crop : comparison.full;
  const rows = values.map((s, method) => [method ? "AI · pix_grad" : "Classical", String(s.count),
    s.count ? s.rmse.toFixed(3) : "—", s.count ? s.mae.toFixed(3) : "—", s.count ? s.bias.toFixed(3) : "—"]);
  const r = comparison, [, , w, h] = ai.comparisonWindow(scene), p = scene.dsm.pixel;
  const summary = `Last completed run · ${r.ai.tiles} AI tiles · overlap ${r.overlap} px · CPU threads ${r.threads} · classical working ${g(r.classical.working)} m / window ${g(r.classical.parameters.window)} m\n` +
    `Scores: ${scope ? "shared crop" : "full input"} · crop ${w} × ${h} cells (${g(w * p)} × ${g(h * p)} m). Full input was used by both methods. Reference is evaluation-only.`;
  return { rows, summary };
}

function publish(outcome) {
  const changed = !scene || outcome.scene.dsm !== scene.dsm;
  scene = outcome.scene;
  comparison = outcome.comparison;
  if (changed) {
    replace(0, scene.original, "Original DSM");
    for (const map of maps.slice(1)) { map.clearLayers(); map.refresh(); }
    probePoint = null;
    drawProbe();
    send("ai:probe", "Click a source pixel to inspect both estimates.");
    applied = [null, null, null];
    setImmediate(fit);
  }
  if (comparison) display();
  const d = scene.dsm;
  send("ai:scene", {
    source: `${path.basename(d.path)} · ${d.width} × ${d.height}\n${g(d.pixel)} m cells · ${scene.reference ? "aligned reference" : "no reference"}`,
    headings: comparison ? null : ["CLASSICAL DTM · Run to generate", "AI DTM · Run to generate"],
    ...scores(),
  });
}

// ----- maps ---------------------------------------------------------------------------------
/** Swap a map's raster but keep its view; a map's first layer joins the linked view. */
function replace(pane, file, name) {
  const map = maps[pane];
  const extent = map.layerCount() ? map.getExtent() : pane && maps[0].layerCount() ? maps[0].getExtent() : null;
  map.clearLayers();
  map.addLayer(file, name);
  map.setTool(tool);
  if (extent) { map.setExtent(extent); applied[pane] = map.getExtent(); }
  map.refresh();
}

function fit() {
  if (!scene || !maps.length) return;
  const [x0, y0, x1, y1] = scope ? ai.cropExtent(scene) : tr.extent(scene.dsm), dx = (x1 - x0) * 0.025, dy = (y1 - y0) * 0.025;
  drawArea();
  maps[0].setExtent({ xMin: x0 - dx, yMin: y0 - dy, xMax: x1 + dx, yMax: y1 + dy });
  syncFrom(0);
}

/** Dim everything outside the shared crop (four translucent owned polygons) and outline it. */
function drawArea() {
  const [x0, y0, x1, y1] = ai.cropExtent(scene), [ox0, oy0, ox1, oy1] = tr.extent(scene.dsm);
  const m = Math.max(ox1 - ox0, oy1 - oy0), [a0, b0, a1, b1] = [ox0 - m, oy0 - m, ox1 + m, oy1 + m];
  const bands = [[a0, y1, a1, b1], [a0, b0, a1, y0], [a0, y0, x0, y1], [x1, y0, a1, y1]];
  const dim = { fillColor: "#ffffff", fillOpacity: 155, lineWidth: 0, lineColor: "#ffffff" };
  for (const map of maps) {
    map.clearShapes();
    if (scope) {
      for (const [a, b, c, d] of bands) map.addPolygon([[a, b], [c, b], [c, d], [a, d], [a, b]], dim);
      map.addLine([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], { lineColor: "#098b97", lineWidth: 2 });
    }
    map.refresh(); // owned shapes are drawn on the next full map render
  }
}

function syncFrom(side) {
  applied[side] = maps[side].getExtent();
  if (!applied[side]) return;
  maps.forEach((map, other) => {
    if (other === side || !map.layerCount()) return;
    map.setExtent(applied[side]);
    applied[other] = map.getExtent();
  });
}

const same = (a, b) => a && b && ["xMin", "yMin", "xMax", "yMax"].every((k) => Math.abs(a[k] - b[k]) < 1e-9);

function display() {
  if (!comparison || !scene) return;
  if (mode === 2 && !scene.reference) {
    mode = 0;
    send("ai:mode", 0);
    status("Attach an aligned reference to compare errors.");
  }
  for (const method of [0, 1]) replace(method + 1, comparison.maps[method][mode], `${method ? "AI" : "Classical"} ${SUFFIX[mode]}`);
  send("ai:display", { headings: [`CLASSICAL ${SUFFIX[mode]}`, `AI ${SUFFIX[mode]}`], legend: LEGENDS[mode] });
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
  let text = `Source pixel ${col} / ${row}\n`;
  if (!d.valid[i]) text += "NoData";
  else {
    text += `DSM ${d.z[i].toFixed(2)} m`;
    if (comparison) text += `\nClassical ${comparison.classical.dtm[i].toFixed(2)} m\nAI ${comparison.ai.dtm[i].toFixed(2)} m`;
    const reference = scene.reference;
    if (reference && reference.valid[i]) text += `\nReference ${reference.z[i].toFixed(2)} m`;
  }
  send("ai:probe", text);
  probePoint = [t[0] + (col + 0.5) * d.pixel, t[3] - (row + 0.5) * d.pixel];
  drawProbe();
}

function handleEvents() {
  const queued = events;
  events = [];
  for (const { side, e } of queued) {
    if (!scene) continue;
    if (e.type === EVENT.VISIBLE_EXTENT_CHANGED) {
      if (maps[side].layerCount() && !same(applied[side], maps[side].getExtent())) syncFrom(side);
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
  else if (name === "model") prepareModel(null);
  else if (name === "zip") localModel();
  else if (name === "run") process_(value);
  else if (name === "save") exportResults();
  else if (name === "mode" && [0, 1, 2].includes(value)) { mode = value; display(); }
  else if (name === "scope" && [0, 1].includes(value)) { scope = value; if (scene) { send("ai:scene", { ...scores(), source: null, headings: null }); fit(); } }
  else if (name === "tool" && value in TOOL) { tool = TOOL[value]; for (const map of maps) map.setTool(tool); }
  else if (name === "zoom" && value === "in") maps[0].zoomIn(1.5);
  else if (name === "zoom" && value === "out") maps[0].zoomOut(1.5);
  else if (name === "zoom" && value === "full") fit();
}

async function start() {
  options = ai.parseOptions(process.argv.slice(3));
  sampleAssets = ds.readAssets();
  terrainAssets = ai.terrainAssets();
  archiveSha256 = ai.modelAssets().sha256;
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-dsm-ai-"));
  window = new BrowserWindow({
    width: 1760, height: 980, minWidth: 1100, minHeight: 720,
    title: "DSM to DTM | Live AI versus classical — GeoKernel", backgroundColor: "#f2f6f8",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("ai:action", (event, name, value) => {
    if (!window || !maps.length || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try { action(name, value); } catch (error) { status(error.message); }
  });
  window.on("resize", layout);
  window.on("close", (event) => {
    // The inference call has no cancellation hook; a queued close completes after the current AI pass.
    if (busy) { event.preventDefault(); closeQueued = true; cancel(); return; }
    stop();
  });
  window.on("closed", () => { window = null; ipcMain.removeHandler("ai:action"); require("electron").app.quit(); });
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
  send("ai:init", { names: tr.PRESET_NAMES });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  token.cancelled = true;
  for (const map of maps) map.close();
  maps = [];
  scene = comparison = null;
  busy = false;
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = null;
}

module.exports = { start, stop };
