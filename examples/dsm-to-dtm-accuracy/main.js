"use strict";

// DSM to DTM: reference accuracy by area. Three linked native GeoKernel 2D maps keep the
// original DSM beside classical and AI error maps on one shared colour scale. Select an area
// to compare numeric errors, their distribution and individual source pixels. Scores use the
// numeric rasters; the maps are display-only Byte RGB images. No inference runs here. All
// native calls stay on Electron's main thread.
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const { BrowserWindow, dialog, ipcMain, screen } = require("electron");
const ds = require("../dsm-to-dtm/dsm-support");
const ac = require("./accuracy-support");
const { Map2D, pump } = require("../dsm-to-dtm-profile/map2d");

const READY = "Ready · select an evaluation area or click any source pixel.";
const IDLE = "Select an area, choose a preset, or click a pixel to inspect errors.";
const SELECTING = "Drag a box on any map. The same source pixels will be evaluated for both methods.";
const FULL_EXTENT = { xMin: 2677090, yMin: 1251340, xMax: 2677360, yMax: 1251610 };
const HEADINGS = [["CLASSICAL DTM · signed error", "AI DTM · signed error"], ["CLASSICAL DTM · absolute error", "AI DTM · absolute error"],
  ["CLASSICAL DTM · terrain estimate", "AI DTM · experimental pix_grad"]];
const EVENT = { VISIBLE_EXTENT_CHANGED: 12, MAP_SELECTION_BOX_FINISHED: 18, MAP_MOUSE_DOWN: 20, MAP_MOUSE_UP: 22 };
const TOOL = { pan: 0, box: 1, select: 3 };
const PARKED = [-1e9, -1e9];

let window = null, maps = [], timer = null, temporary = null, events = [];
let options = null, assets = null, token = { cancelled: true }, grids = null, rects = null;
let busy = false, closeQueued = false, generation = 0, mode = 0, limitIndex = 1, threshold = 2, selecting = false;
let area = null, areaName = "", metrics = null, probePoint = null, presses = [null, null, null], applied = [null, null, null];

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function status(message, extra = {}) {
  send("accuracy:status", { message, busy, ready: !!grids, selecting, mode, ...extra });
}

// ----- loading ------------------------------------------------------------------------------
async function startLoad() {
  if (busy) return;
  token = { cancelled: false };
  const current = token;
  busy = true;
  setSelecting(false);
  const folder = path.join(temporary, String(++generation));
  try {
    const sample = await ds.prepareSample(assets, options, current, (value, message) => status(message, { percent: value }));
    ds.checkCancel(current);
    ds.configureRuntime(sample);
    fs.mkdirSync(folder, { recursive: true });
    const message = "Reading heights and preparing shared-scale Byte RGB maps...";
    status(message, { percent: 0 });
    await new Promise(setImmediate);
    const loaded = ds.readGrids(sample, current);
    const files = await ac.prepareDisplays(loaded, folder, current, (percent) => status(message, { percent }));
    ds.checkCancel(current);
    publish(loaded, files);
    busy = false;
    if (area) { updateMetrics(); drawArea(); } else applyPreset(0);
    send("accuracy:instructions", IDLE);
    status(READY);
  } catch (error) {
    busy = false;
    const cancelled = error instanceof ds.Cancelled || current.cancelled;
    status(cancelled ? "Preparation cancelled; completed comparison retained." : error.message);
    if (!closeQueued && !cancelled && window) dialog.showMessageBox(window, { type: "warning", title: "Unable to load comparison", message: error.message });
  }
  if (closeQueued) setImmediate(() => window?.close());
}

function publish(loaded, files) {
  grids = loaded;
  maps.forEach((map, pane) => {
    map.clearShapes();
    map.clearLayers();
    // The empty map adopts the first layer's CRS (EPSG:2056); new layers go to index 0.
    const list = pane === 0 ? [files.original] : files.methods[pane - 1];
    list.forEach((file, k) => map.addLayer(file, pane === 0 ? "Original DSM" : `${pane === 1 ? "Classical" : "AI"} display ${k}`));
    if (map.layerCount() !== list.length) throw new Error("The display layers were not added.");
    map.setTool(TOOL.pan);
  });
  applied = [null, null, null];
  fullExtent();
  selectDisplay();
}

function cancel() {
  token.cancelled = true;
  status("Cancelling preparation...");
}

// ----- maps ---------------------------------------------------------------------------------
function fullExtent() {
  maps[0].setExtent(FULL_EXTENT);
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

function setSelecting(on) {
  selecting = on;
  for (const map of maps) map.setTool(on ? TOOL.select : TOOL.pan);
  send("accuracy:instructions", on ? SELECTING : IDLE);
}

function selectDisplay() {
  const limit = ac.DISPLAY_LIMITS[limitIndex];
  // Shared legend: 21 colour stops of the same scale the maps use.
  const stops = Array.from({ length: 21 }, (_, i) => {
    const t = i / 20;
    return ac.errorColor(mode === 0 ? (t * 2 - 1) * limit : t * limit, mode === 1, limit);
  });
  send("accuracy:display", { mode, limit, stops, headings: grids ? HEADINGS[mode] : null });
  if (!grids) return;
  const selected = mode === 2 ? 8 : (mode === 1 ? 4 : 0) + limitIndex;
  for (const map of maps.slice(1)) {
    for (let k = 0; k < 9; k++) map.setLayerVisible(8 - k, k === selected); // files 0..8 were prepended in order
    map.refresh();
  }
}

/** Dim everything outside the evaluated cells (four translucent bands) and outline them. */
function drawArea() {
  if (!grids || !area) return;
  const [x0, y0, x1, y1] = ac.windowExtent(grids, area);
  const t = grids.transform, margin = 2000;
  const ox0 = t[0] - margin, oy0 = t[3] + grids.height * t[5] - margin, ox1 = t[0] + grids.width * t[1] + margin, oy1 = t[3] + margin;
  const bands = [[ox0, y1, ox1, oy1], [ox0, oy0, ox1, y0], [ox0, y0, x0, y1], [x1, y0, ox1, y1]];
  const dim = { fillColor: "#ffffff", fillOpacity: 100, lineColor: "#ffffff", lineWidth: 0 };
  for (const map of maps) {
    map.clearShapes();
    for (const [a, b, c, d] of bands) if (c > a && d > b) map.addPolygon([[a, b], [c, b], [c, d], [a, d], [a, b]], dim);
    map.addLine([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], { lineColor: "#167d8d", lineWidth: 2 });
    map.refresh(); // owned shapes are drawn on the next full map render
  }
}

/** The probed cell as an overlay point on every map. It is moved, never removed: removal is
 *  deferred to a Qt event loop this host never runs, so a removed point would reappear. */
function drawProbe() {
  const [x, y] = probePoint || PARKED;
  for (const map of maps) map.setOverlayPoint("probe", x, y, { pointColor: "#dc3672", pointSize: 11, lineColor: "#ffffff", lineWidth: 2 });
}

function handleEvents() {
  const queued = events;
  events = [];
  for (const { side, e } of queued) {
    if (!grids) continue;
    if (e.type === EVENT.VISIBLE_EXTENT_CHANGED) {
      if (!same(applied[side], maps[side].getExtent())) syncFrom(side);
    } else if (e.type === EVENT.MAP_SELECTION_BOX_FINISHED && selecting) {
      chooseArea([e.extent.xMin, e.extent.yMin, e.extent.xMax, e.extent.yMax], "User-selected area");
      setSelecting(false);
      status("Updated both methods on exactly the same source cells.");
    } else if (e.type === EVENT.MAP_MOUSE_DOWN && e.int2 === 1) {
      presses[side] = [e.screen.left, e.screen.top];
    } else if (e.type === EVENT.MAP_MOUSE_UP && e.int2 === 1) {
      const press = presses[side];
      presses[side] = null;
      if (press && !selecting && Math.abs(press[0] - e.screen.left) + Math.abs(press[1] - e.screen.top) <= 3) inspect(e.extent.xMin, e.extent.yMin);
    }
  }
}

// ----- evaluation ---------------------------------------------------------------------------
function chooseArea(extent, name, preset = -1) {
  if (!grids) return;
  try { area = ac.pixelWindow(grids, extent); }
  catch (error) { status(error.message); return; }
  areaName = name;
  send("accuracy:preset", preset < 0 ? 4 : preset);
  updateMetrics();
  drawArea();
  status("Updated both methods on exactly the same source cells.");
}

function applyPreset(index) {
  if (!grids) return;
  if (index === 4) { setSelecting(true); status(READY); return; }
  setSelecting(false);
  chooseArea(ac.presetArea(grids, index), ac.PRESETS[index], index);
}

function updateMetrics() {
  if (!grids || !area) return;
  metrics = ac.measure(grids, area, threshold);
  send("accuracy:metrics", { metrics, threshold, areaName });
}

function inspect(x, y) {
  if (!grids || busy) return;
  const t = grids.transform, col = (x - t[0]) / 0.5, row = (t[3] - y) / 0.5;
  if (!(col >= 0 && row >= 0 && col < grids.width && row < grids.height)) { status("Click inside the source raster."); return; }
  const cx = Math.floor(col), cy = Math.floor(row), i = cy * grids.width + cx, z = grids.z;
  probePoint = [t[0] + (cx + 0.5) * 0.5, t[3] - (cy + 0.5) * 0.5];
  const inside = area && cx >= area.left && cx < area.left + area.width && cy >= area.top && cy < area.top + area.height;
  const f = (v, d = 2) => v.toFixed(d);
  send("accuracy:probe", `SOURCE PIXEL · column ${cx} / row ${cy}${inside ? "" : "\nOutside evaluation area"}\n\n` +
    `DSM: ${f(z[0][i])} m\nReference: ${f(z[3][i])} m\n\nClassical: ${f(z[1][i])} m · error ${f(z[1][i] - z[3][i], 3)} m\n` +
    `AI: ${f(z[2][i])} m · error ${f(z[2][i] - z[3][i], 3)} m`);
  drawProbe();
}

async function exportReport() {
  if (!grids || !area || !metrics) return;
  const [g, w, name, limit, current] = [grids, area, areaName, threshold, metrics];
  const result = await dialog.showSaveDialog(window, { title: "Export evaluation report", defaultPath: "accuracy-report.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return;
  try { ac.exportReport(result.filePath, g, w, name, limit, current, assets.sha256); }
  catch (error) { dialog.showMessageBox(window, { type: "warning", title: "Export report", message: error.message }); return; }
  status("Saved selected-area metrics and source provenance.");
}

function layout() {
  if (!window || !rects || !maps.length) return;
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  rects.forEach((rect, i) => maps[i].place(Math.round(rect.x * scale), Math.round(rect.y * scale), Math.round(rect.width * scale), Math.round(rect.height * scale)));
}

// ----- window -------------------------------------------------------------------------------
function action(name, value) {
  if (name === "layout" && Array.isArray(value) && value.length === 3) { rects = value; layout(); return; }
  if (name === "retry") { startLoad(); return; }
  if (name === "cancel") { cancel(); return; }
  if (name === "mode" && [0, 1, 2].includes(value)) { mode = value; selectDisplay(); status(busy ? "Preparing..." : READY); return; }
  if (name === "range" && [0, 1, 2, 3].includes(value)) { limitIndex = value; selectDisplay(); return; }
  if (!grids || busy) return;
  if (name === "threshold" && Number.isFinite(value) && value >= 0.1 && value <= 20) { threshold = value; updateMetrics(); }
  else if (name === "preset" && [0, 1, 2, 3, 4].includes(value)) applyPreset(value);
  else if (name === "select") { setSelecting(!selecting); status(READY); }
  else if (name === "current") { const e = maps[0].getExtent(); if (e) chooseArea([e.xMin, e.yMin, e.xMax, e.yMax], "Current map view"); }
  else if (name === "tool" && (value === "pan" || value === "box")) { setSelecting(false); for (const map of maps) map.setTool(TOOL[value]); status(READY); }
  else if (name === "zoom" && value === "in") maps[0].zoomIn(1.5);
  else if (name === "zoom" && value === "out") maps[0].zoomOut(1.5);
  else if (name === "zoom" && value === "full") fullExtent();
  else if (name === "export") exportReport();
}

async function start() {
  options = ds.parseOptions(process.argv.slice(3));
  assets = ds.readAssets();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-dsm-accuracy-"));
  window = new BrowserWindow({
    width: 1720, height: 970, minWidth: 1100, minHeight: 720,
    title: "DSM to DTM | Where is each method more accurate? — GeoKernel", backgroundColor: "#f2f6f8",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("accuracy:action", (event, name, value) => {
    if (!window || !maps.length || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try { action(name, value); } catch (error) { status(error.message); }
  });
  window.on("resize", layout);
  window.on("close", (event) => {
    if (busy) { event.preventDefault(); closeQueued = true; cancel(); return; }
    stop();
  });
  window.on("closed", () => { window = null; ipcMain.removeHandler("accuracy:action"); require("electron").app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  pump();
  const parent = koffi.decode(window.getNativeWindowHandle(), "void *");
  maps = [0, 1, 2].map((side) => new Map2D(parent, (e) => events.push({ side, e })));
  layout();
  timer = setInterval(() => {
    if (!maps.length) return;
    pump();
    try { handleEvents(); } catch (error) { status(error.message); }
  }, 16);
  selectDisplay();
  send("accuracy:init", {});
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  token.cancelled = true;
  for (const map of maps) map.close();
  maps = [];
  grids = null;
  busy = false;
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = null;
}

module.exports = { start, stop };
