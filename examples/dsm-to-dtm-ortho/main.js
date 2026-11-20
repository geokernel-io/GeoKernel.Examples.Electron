"use strict";

// DSM + orthophoto to DTM: three independent methods. Compare newly computed terrain estimates on the
// same full DSM: the native classical filter (DSM only), the experimental pix_grad model (DSM only) and
// the experimental rgb_grad_fm model (DSM plus an aligned RGB orthophoto). Four linked native GeoKernel
// 2D maps keep the input context on the left. The reference is evaluation-only; the methods do not feed
// each other. Map and GDAL calls stay on Electron's main thread (long loops yield); each inference is an
// asynchronous native call.
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const { BrowserWindow, dialog, ipcMain, screen } = require("electron");
const ds = require("../dsm-to-dtm/dsm-support");
const tr = require("../dsm-to-dtm-processing/terrain-support");
const ai = require("../dsm-to-dtm-ai/ai-support");
const or = require("./ortho-support");
const { Map2D, pump } = require("../dsm-to-dtm-profile/map2d");

const EVENT = { VISIBLE_EXTENT_CHANGED: 12, MAP_MOUSE_DOWN: 20, MAP_MOUSE_UP: 22 };
const TOOL = { pan: 0, box: 1 };
const PARKED = [-1e9, -1e9];
const SUFFIX = ["DTM · relief", "REMOVED HEIGHT", "ERROR · DTM − reference"];
const PENDING = ["CLASSICAL · Run to generate", "PIX_GRAD · Run to generate", "RGB_GRAD_FM · Run to generate"];
const NAMES = ["Classical · DSM", "pix_grad · DSM", "rgb_grad_fm · DSM + RGB"];
const LEGENDS = [
  "Same relief light/contrast for all methods; source orthophoto or DSM remains on the left.",
  "Shared removed-height scale: white 0 m → red ≥20 m. Display saturation only; numeric heights are unchanged.",
  "Shared signed-error scale: blue ≤−2 m · white 0 · red ≥+2 m. Scores use identical valid reference cells in the selected scope.",
];

let window = null, maps = [], timer = null, temporary = null, events = [], rects = null;
let options = null, sampleAssets = null, archiveSha256 = null, token = { cancelled: true };
let scene = null, comparison = null, models = null, setupModels = false;
let busy = false, closeQueued = false, generation = 0, input = 1, mode = 0, scope = 1, tool = TOOL.pan;
let probePoint = null, presses = [null, null, null, null], applied = [null, null, null, null];

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function status(message, extra = {}) {
  send("ortho:status", { message, busy, hasScene: !!scene, hasModels: !!models, hasComparison: !!comparison, ...extra });
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
    send("ortho:state", result?.message ?? "Ready.");
  } catch (error) {
    busy = false;
    if (!window) return;
    const cancelled = error instanceof ds.Cancelled || current.cancelled;
    const message = cancelled ? "Cancelled; last completed comparison retained." : error.message;
    status(message);
    send("ortho:state", message);
    if (!closeQueued && !cancelled) dialog.showMessageBox(window, { type: "warning", title: "Unable to complete operation", message: error.message });
  }
  if (closeQueued) setImmediate(() => window?.close());
  else if (setupModels && scene && !models) { setupModels = false; setImmediate(() => prepareModels(-1, null)); }
}

function prepareModels(selected, local) {
  job(async (current, progress) => {
    const folders = [];
    try {
      for (const index of [0, 1]) folders.push(await or.prepareModel(options, index, selected === index ? local : null, current, progress));
    } catch (error) {
      if (error instanceof ds.Cancelled) throw error;
      throw new Error(`${error.message}\nUse the pinned model ZIPs or retry the published URLs.`);
    }
    return { models: folders, message: scene ? "Inputs and both models ready. Press Run." : "Models ready; load aligned DSM and RGB." };
  }, (outcome) => {
    models = outcome.models;
    send("ortho:models", "pix_grad + rgb_grad_fm ready\nVerified 256 × 256 tiles · CPU");
  });
}

async function chooseModel(index) {
  const result = await dialog.showOpenDialog(window, { title: `Choose the pinned ${or.METHODS[index + 1]} model ZIP`, properties: ["openFile"], filters: [{ name: "ZIP", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths[0] || busy) return;
  prepareModels(index, result.filePaths[0]);
}

async function loadScene(dsmPath, rgbPath, referencePath, manifest, folder, current, progress) {
  progress(5, "Reading source DSM...");
  await new Promise(setImmediate);
  const dsm = tr.readRaster(dsmPath, current);
  progress(25, "Checking RGB channels, grid and coverage...");
  await new Promise(setImmediate);
  const rgb = await or.readOrtho(dsm, rgbPath, current);
  let reference = null;
  if (referencePath) {
    progress(50, "Reading evaluation-only reference...");
    await new Promise(setImmediate);
    reference = tr.readRaster(referencePath, current);
    tr.validateReference(dsm, reference);
  }
  if (manifest.standard_full_tile) {
    const [x0, y0, x1, y1] = tr.extent(dsm), gdal = ds.bindGdal();
    const a = gdal.newSrs(null), b = gdal.newSrs(null);
    let epsg2056;
    try { epsg2056 = gdal.fromUser(a, dsm.projection) === 0 && gdal.fromEpsg(b, 2056) === 0 && gdal.same(a, b) !== 0; }
    finally { gdal.destroySrs(a); gdal.destroySrs(b); }
    if (!epsg2056 || dsm.width !== 2000 || dsm.height !== 2000 || dsm.pixel !== 0.5 || x0 !== 2677000 || y0 !== 1251000 || x1 !== 2678000 || y1 !== 1252000)
      throw new Error("Unexpected Zurich sample grid.");
  }
  progress(70, "Preparing original DSM relief...");
  const original = ds.writeRgb(path.join(folder, "original.tif"), dsm.width, dsm.height, dsm.transform, dsm.projection, ...await tr.relief(dsm, dsm.z, current));
  ds.checkCancel(current);
  return { scene: { dsm, rgb, reference, original, manifest }, comparison: null, message: "Aligned inputs ready. Prepare both models and Run." };
}

function loadSample() {
  const folder = nextFolder();
  setupModels = !models;
  job(async (current, progress) => {
    const sample = await ds.prepareSample(sampleAssets, options, current, progress);
    ds.checkCancel(current);
    ds.configureRuntime(sample);
    const manifest = JSON.parse(fs.readFileSync(path.join(sample, "source-manifest.json"), "utf8"));
    return loadScene(path.join(sample, "dsm.tif"), path.join(sample, "ortho_rgb.tif"), path.join(sample, "reference.tif"), manifest, folder, current, progress);
  }, publish);
}

async function openInputs() {
  const filters = [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }];
  const dsm = await dialog.showOpenDialog(window, { title: "Open metre-height DSM", properties: ["openFile"], filters });
  if (dsm.canceled || !dsm.filePaths[0] || busy) return;
  const rgb = await dialog.showOpenDialog(window, { title: "Open exactly aligned RGB Byte orthophoto", defaultPath: path.dirname(dsm.filePaths[0]), properties: ["openFile"], filters });
  if (rgb.canceled || !rgb.filePaths[0] || busy) return;
  const folder = nextFolder();
  job((current, progress) => loadScene(dsm.filePaths[0], rgb.filePaths[0], null, {}, folder, current, progress), publish);
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
    const updated = completed ? await or.attachReference(nextScene, completed, folder, archiveSha256, current, progress) : null;
    ds.checkCancel(current);
    return { scene: nextScene, comparison: updated, message: "Reference updated; all generated height arrays are unchanged." };
  }, publish);
}

function process_(values) {
  if (!scene || !models) return;
  const overlap = Number(values?.overlap), threads = Number(values?.threads), preset = Number(values?.preset);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > 128) { status("AI overlap must be a whole number from 0 to 128 px."); return; }
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) { status("CPU threads must be a whole number from 1 to 8."); return; }
  if (![0, 1, 2].includes(preset)) return;
  const currentScene = scene, packages = [...models], folder = nextFolder();
  const parameters = ai.effectiveParameters(currentScene.dsm, tr.PRESETS[preset]);
  job(async (current, progress) => {
    const result = await or.compare(currentScene, packages, parameters, overlap, threads, folder, archiveSha256, current, progress);
    return { scene: currentScene, comparison: result, message: "All three methods completed from the same full source grid." };
  }, publish);
}

async function exportResults() {
  if (!comparison) return;
  const result = await dialog.showOpenDialog(window, { title: "Choose parent folder for a new complete result bundle", properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0] || busy || !comparison) return;
  const parent = result.filePaths[0], completed = comparison;
  job(async (current, progress) => {
    const target = await or.exportBundle(completed, parent, current, progress);
    return { message: `Saved complete comparison bundle: ${target}` };
  }, () => {});
}

function cancel() {
  token.cancelled = true;
  status("Cancelling; completed comparison retained...");
}

// ----- publishing ---------------------------------------------------------------------------
function scores() {
  if (!comparison) return { rows: null, summary: "Aligned inputs loaded. Run to create all three terrain estimates." };
  const values = scope ? comparison.crop : comparison.full;
  const rows = values.map((s, method) => [NAMES[method], String(s.count), s.count ? s.rmse.toFixed(3) : "—", s.count ? s.mae.toFixed(3) : "—", s.count ? s.bias.toFixed(3) : "—"]);
  const r = comparison, [, , w, h] = ai.comparisonWindow(scene), p = scene.dsm.pixel;
  const summary = `Last run · pix_grad ${r.ai[0].tiles} tiles · rgb_grad_fm ${r.ai[1].tiles} tiles · overlap ${r.overlap} px · CPU threads ${r.threads} · classical working ${g(r.classical.working)} m / window ${g(r.classical.parameters.window)} m\n` +
    `Evaluation: ${scope ? "shared crop" : "full input"} · common crop ${w} × ${h} cells (${g(w * p)} × ${g(h * p)} m). All methods processed the full input; outside-crop map areas are dimmed.`;
  return { rows, summary };
}

function publish(outcome) {
  const changed = !scene || outcome.scene.dsm !== scene.dsm;
  scene = outcome.scene;
  comparison = outcome.comparison;
  if (changed) {
    showInput();
    for (const map of maps.slice(1)) { map.clearLayers(); map.refresh(); }
    probePoint = null;
    drawProbe();
    send("ortho:probe", "Click a source pixel to inspect RGB and all terrain estimates.");
    applied = [null, null, null, null];
    setImmediate(fit);
  }
  if (comparison) display();
  const d = scene.dsm;
  send("ortho:scene", {
    source: `${path.basename(d.path)} + ${path.basename(scene.rgb.path)}\n${d.width} × ${d.height} · ${g(d.pixel)} m cells\n${scene.reference ? "Aligned reference attached" : "No reference"}`,
    headings: comparison ? null : PENDING,
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

function showInput() {
  if (!scene) return;
  replace(0, input ? scene.rgb.path : scene.original, input ? "RGB orthophoto" : "Original DSM");
  send("ortho:input", input ? "RGB ORTHOPHOTO · source input" : "ORIGINAL DSM · source input");
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
    send("ortho:mode", 0);
    status("Attach an aligned reference to show errors.");
  }
  for (const method of [0, 1, 2]) replace(method + 1, comparison.maps[method][mode], `${or.METHODS[method]} ${SUFFIX[mode]}`);
  send("ortho:display", { headings: or.METHODS.map((m) => `${m.toUpperCase()} ${SUFFIX[mode]}`), legend: LEGENDS[mode] });
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
  const col = Math.floor(cx), row = Math.floor(cy), i = row * d.width + col, [r, gr, b] = scene.rgb.bands.map((band) => band[i]);
  let text = `Source pixel ${col} / ${row}\nRGB ${r} / ${gr} / ${b}\n`;
  if (!d.valid[i]) text += "DSM NoData";
  else {
    text += `DSM ${d.z[i].toFixed(2)} m`;
    if (comparison) for (const method of [0, 1, 2]) text += `\n${or.METHODS[method]} ${or.heights(comparison, method)[i].toFixed(2)} m`;
    const reference = scene.reference;
    if (reference && reference.valid[i]) text += `\nReference ${reference.z[i].toFixed(2)} m`;
  }
  send("ortho:probe", text);
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
  const factor = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  rects.forEach((rect, i) => maps[i].place(Math.round(rect.x * factor), Math.round(rect.y * factor), Math.round(rect.width * factor), Math.round(rect.height * factor)));
}

// ----- window -------------------------------------------------------------------------------
function action(name, value) {
  if (name === "layout" && Array.isArray(value) && value.length === 4) { rects = value; layout(); return; }
  if (name === "cancel") { cancel(); return; }
  if (busy) return;
  if (name === "sample") loadSample();
  else if (name === "open") openInputs();
  else if (name === "reference") openReference();
  else if (name === "models") prepareModels(-1, null);
  else if (name === "model" && [0, 1].includes(value)) chooseModel(value);
  else if (name === "run") process_(value);
  else if (name === "save") exportResults();
  else if (name === "input" && [0, 1].includes(value)) { input = value; showInput(); }
  else if (name === "mode" && [0, 1, 2].includes(value)) { mode = value; display(); }
  else if (name === "scope" && [0, 1].includes(value)) { scope = value; if (scene) { send("ortho:scene", { ...scores(), source: null, headings: null }); fit(); } }
  else if (name === "tool" && value in TOOL) { tool = TOOL[value]; for (const map of maps) map.setTool(tool); }
  else if (name === "zoom" && value === "in") maps[0].zoomIn(1.5);
  else if (name === "zoom" && value === "out") maps[0].zoomOut(1.5);
  else if (name === "zoom" && value === "full") fit();
}

async function start() {
  options = or.parseOptions(process.argv.slice(3));
  sampleAssets = or.sampleAssets();
  archiveSha256 = [or.modelAssets(0).sha256, or.modelAssets(1).sha256];
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-dsm-ortho-"));
  window = new BrowserWindow({
    width: 1920, height: 980, minWidth: 1200, minHeight: 720,
    title: "DSM + Orthophoto to DTM | Three independent methods — GeoKernel", backgroundColor: "#f2f6f8",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("ortho:action", (event, name, value) => {
    if (!window || !maps.length || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try { action(name, value); } catch (error) { status(error.message); }
  });
  window.on("resize", layout);
  window.on("close", (event) => {
    // The inference call has no cancellation hook; a queued close completes after the current AI pass.
    if (busy) { event.preventDefault(); closeQueued = true; cancel(); return; }
    stop();
  });
  window.on("closed", () => { window = null; ipcMain.removeHandler("ortho:action"); require("electron").app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  pump();
  const parent = koffi.decode(window.getNativeWindowHandle(), "void *");
  maps = [0, 1, 2, 3].map((side) => new Map2D(parent, (e) => events.push({ side, e })));
  for (const map of maps) map.setTool(tool);
  layout();
  timer = setInterval(() => {
    if (!maps.length) return;
    pump();
    try { handleEvents(); } catch (error) { status(error.message); }
  }, 16);
  send("ortho:init", { names: tr.PRESET_NAMES });
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
