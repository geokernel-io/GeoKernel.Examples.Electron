"use strict";

// DSM to DTM: ground beneath buildings. Two linked native GeoKernel 3D viewers show the
// original DSM beside a prepared terrain estimate. The slider interpolates numeric heights
// between both endpoints. No inference runs here; the reference DTM is used only for the
// profile chart and the stored crop scores. All native calls stay on Electron's main thread.
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const { BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const { createNativeLibrary } = require("geokernel-electron");
const ds = require("./dsm-support");
const { Viewer3D } = require("./viewer3d");

const READY = "Ready · Original DSM stays visible | Drag: pan · Wheel: zoom · Middle/Ctrl+drag: orbit";
const CONTROLS = "Left drag: pan\nWheel or right drag: zoom\nMiddle drag or Ctrl + left drag: orbit\nBoth cameras stay linked.\n\nMove the surface slider and release to update geometry. The original view stays unchanged.";

let window = null, viewers = [], pump = null, timer = null, temporary = null;
let options = null, assets = null, token = { cancelled: true }, grids = null, work = null, loading = [];
let ready = false, busy = false, closeQueued = false, serial = 0, heightScale = 1;
let committed = { method: 1, percent: 100 }, lastCamera = [null, null], rects = null;

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function status(message, extra = {}) {
  send("dsm:status", { message, busy, ready, ...extra });
}

function failure(message) {
  busy = false;
  loading = [];
  status(message);
  send("dsm:restore", committed);
  if (closeQueued) { setImmediate(() => window?.close()); return; }
  if (!token.cancelled) dialog.showMessageBox(window, { type: "warning", title: "Sample unavailable", message });
}

function heading(method, percent) {
  const name = method === 1 ? "CLASSICAL" : "AI · pix_grad";
  if (percent === 100) return name + " DTM · prepared terrain estimate";
  if (percent === 0) return "ORIGINAL DSM · slider at 0%";
  return `${name} · ${percent}% removal transition (display only)`;
}

function metrics(manifest) {
  const m = manifest.metrics || {}, c = m.classical || {}, a = m.ai || {};
  const f = (value) => Number(value || 0).toFixed(2);
  return `REFERENCE CHECK · this crop only\n\nClassical: RMSE ${f(c.rmse_m)} m · MAE ${f(c.mae_m)} m\nAI: RMSE ${f(a.rmse_m)} m · MAE ${f(a.mae_m)} m\n\n` +
    "250,000 shared reference pixels\nLower error is better.\n\nScores describe the final DTM endpoints, not the transition slider.";
}

// ----- loading ------------------------------------------------------------------------------
async function startLoad(selection) {
  if (busy) return;
  token = { cancelled: false };
  const current = token;
  busy = true;
  const { method, percent } = selection;
  const surface = path.join(temporary, `surface-${++serial}.tif`);
  try {
    const folder = await ds.prepareSample(assets, options, current, (value, message) => status(message, { percent: value }));
    ds.checkCancel(current);
    ds.configureRuntime(folder);
    status("Reading numeric heights and preparing both native 3D scenes...", { percent: 0 });
    const loaded = ds.readGrids(folder, current);
    ds.checkCancel(current);
    beginNative({ grids: loaded, method, percent, original: path.join(folder, "dsm.tif"), result: ds.surfaceFile(loaded, method, percent, surface) });
  } catch (error) {
    failure(error instanceof ds.Cancelled || current.cancelled ? "Loading cancelled. Previous complete views retained." : error.message);
  }
}

function updateSurface(selection) {
  if (!ready || busy || !grids) return;
  const { method, percent } = selection;
  if (method === committed.method && percent === committed.percent) return;
  token = { cancelled: false };
  busy = true;
  status("Preparing the interpolated display surface...", { percent: 0 });
  try {
    const result = ds.surfaceFile(grids, method, percent, path.join(temporary, `surface-${++serial}.tif`));
    ds.checkCancel(token);
    beginNative({ grids, method, percent, original: null, result });
  } catch (error) {
    failure(error instanceof ds.Cancelled ? "Loading cancelled. Previous complete views retained." : error.message);
  }
}

function beginNative(next) {
  // Viewer3D prepares geometry on its own worker; the C API reports no percentage.
  work = next;
  const neutral = path.join(next.grids.folder, "neutral_surface.tif");
  loading = [];
  if (next.original) { viewers[0].load(next.original, neutral, 500); loading.push(0); }
  viewers[1].load(next.result, neutral, 500);
  loading.push(1);
  status("Preparing native 3D terrain...", { indeterminate: true });
}

function pollNative() {
  if (!loading.length) return;
  let states;
  try { states = loading.map((index) => viewers[index].poll()); }
  catch (error) { failure(error.message); return; }
  if (states.includes(0)) return;
  loading = [];
  if (token.cancelled || states.includes(-2)) { failure("Loading cancelled. Previous complete views retained."); return; }
  commit();
}

function commit() {
  const first = !ready;
  const gridsChanged = grids !== work.grids;
  grids = work.grids;
  ready = true;
  committed = { method: work.method, percent: work.percent };
  for (const viewer of viewers) viewer.height(heightScale);
  if (first) resetView(); else syncFrom(0);
  busy = false;
  send("dsm:committed", {
    ...committed, heading: heading(committed.method, committed.percent), metrics: metrics(grids.manifest),
    profile: gridsChanged ? ds.profile(grids) : undefined,
  });
  status(READY);
  if (closeQueued) setImmediate(() => window?.close());
}

function cancel() {
  token.cancelled = true;
  for (const viewer of viewers) viewer.cancel();
  status("Cancelling... Previous complete views are retained.");
}

// ----- cameras ------------------------------------------------------------------------------
function renderScale() {
  // Viewer3D maps local ENU metres to render units by 2 / horizontal span of the pixel-centre grid.
  return 2 / ((grids.width - 1) * grids.transform[1]);
}

function resetView() {
  if (!ready) return;
  viewers[0].reset();
  let mean = 0;
  for (const value of grids.z[0]) mean += value;
  mean /= grids.z[0].length;
  // Both scenes share the grid-centre origin at zero height: the crop centre at the mean DSM
  // height is (0, mean * scale * exaggeration, 0) in render units.
  viewers[0].moveCamera([20, 48, 3.25, 0, mean * renderScale() * heightScale, 0], 0);
  syncFrom(0);
}

function syncFrom(source) {
  // Same grid, same origin and (to within 1e-5) the same render scale: render-space cameras
  // transfer directly between the two native scenes.
  viewers[1 - source].moveCamera(viewers[source].camera(), 0);
  lastCamera = viewers.map((viewer) => viewer.camera());
}

function sameCamera(a, b) {
  return a && b && a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) < 1e-5;
}

function pollCameras() {
  // Pause while a scene is being replaced: its interim camera must not propagate.
  if (!ready || busy) return;
  for (let i = 0; i < 2; i++) if (!sameCamera(lastCamera[i], viewers[i].camera())) { syncFrom(i); break; }
}

function cameraAction(name) {
  if (!ready) return;
  if (name === "reset") { resetView(); return; }
  const camera = viewers[0].camera();
  if (name === "top") { camera[0] = 0; camera[1] = 85; }
  else if (name === "zoom-in") camera[2] = Math.min(Math.max(camera[2] * 0.8, 0.05), 20);
  else if (name === "zoom-out") camera[2] = Math.min(Math.max(camera[2] * 1.25, 0.05), 20);
  else return;
  viewers[0].moveCamera(camera, 0);
  syncFrom(0);
}

function setExaggeration(value) {
  const old = heightScale;
  heightScale = value;
  for (const viewer of viewers) {
    const camera = ready ? viewer.camera() : null;
    viewer.height(value);
    if (camera) { camera[4] *= value / old; viewer.moveCamera(camera, 0); }
  }
  if (ready) syncFrom(0);
}

function layout() {
  if (!window || !rects || !viewers.length) return;
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  rects.forEach((rect, i) => viewers[i].place(Math.round(rect.x * scale), Math.round(rect.y * scale), Math.round(rect.width * scale), Math.round(rect.height * scale)));
}

// ----- window -------------------------------------------------------------------------------
function validSelection(value) {
  return value && [1, 2].includes(value.method) && Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100;
}

async function start() {
  options = ds.parseOptions(process.argv.slice(3));
  assets = ds.readAssets();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-dsm-to-dtm-"));
  window = new BrowserWindow({
    width: 1520, height: 960, minWidth: 1000, minHeight: 700,
    title: "DSM to DTM | Ground beneath buildings — GeoKernel", backgroundColor: "#f2f6f8",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("dsm:action", (event, action, value) => {
    if (!window || !viewers.length || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try {
      if (action === "layout" && Array.isArray(value) && value.length === 2) { rects = value; layout(); }
      else if (action === "retry" && validSelection(value)) startLoad(value);
      else if (action === "surface" && validSelection(value)) updateSurface(value);
      else if (action === "cancel") cancel();
      else if (action === "camera" && typeof value === "string") cameraAction(value);
      else if (action === "exaggeration" && Number.isFinite(value) && value >= 0.25 && value <= 4) setExaggeration(value);
      else if (action === "folder") { fs.mkdirSync(options.dataRoot, { recursive: true }); shell.openPath(options.dataRoot); }
      else if (action === "controls") dialog.showMessageBox(window, { title: "Camera controls", message: CONTROLS });
    } catch (error) { status(error.message); }
  });
  window.on("resize", layout);
  window.on("close", (event) => {
    if (busy) { event.preventDefault(); closeQueued = true; cancel(); return; }
    stop();
  });
  window.on("closed", () => { window = null; ipcMain.removeHandler("dsm:action"); require("electron").app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  pump = createNativeLibrary().getFunction("GeoKernelViewer_ProcessEvents");
  pump();
  const parent = koffi.decode(window.getNativeWindowHandle(), "void *");
  viewers = [new Viewer3D(parent), new Viewer3D(parent)];
  layout();
  timer = setInterval(() => {
    if (!viewers.length) return;
    pump();
    pollNative();
    try { pollCameras(); } catch (error) { status(error.message); }
  }, 16);
  send("dsm:init", {});
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  token.cancelled = true;
  for (const viewer of viewers) viewer.close();
  viewers = [];
  ready = busy = false;
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = null;
}

module.exports = { start, stop };
