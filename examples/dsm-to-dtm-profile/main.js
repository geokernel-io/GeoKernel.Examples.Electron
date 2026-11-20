"use strict";

// DSM to DTM: interactive elevation profile. Draw an A → B transect on two linked native
// GeoKernel 2D maps and compare the original DSM, classical DTM, AI DTM and provider
// reference heights. Profiles sample the numeric rasters; the maps show matching display
// reliefs. No inference runs here. All native calls stay on Electron's main thread.
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const { BrowserWindow, dialog, ipcMain, screen } = require("electron");
const ds = require("../dsm-to-dtm/dsm-support");
const ps = require("./profile-support");
const { Map2D, pump } = require("./map2d");

const READY = "Ready · draw A → B on either map; move over the chart to inspect heights.";
const FULL_EXTENT = { xMin: 2677090, yMin: 1251340, xMax: 2677360, yMax: 1251610 };
const HEADINGS = ["CLASSICAL DTM · prepared estimate", "AI DTM · experimental pix_grad", "REFERENCE DTM · evaluation only"];
const COLORS = ["#66768a", "#087e8b", "#8857bd", "#d98419"];
const EVENT = { VISIBLE_EXTENT_CHANGED: 12, MAP_MOUSE_DOWN: 20, MAP_MOUSE_UP: 22 };
const TOOL = { pan: 0, box: 1 };

let window = null, maps = [], timer = null, temporary = null, events = [];
let options = null, assets = null, token = { cancelled: true }, grids = null, rects = null;
let busy = false, closeQueued = false, generation = 0, surface = 1, spacing = 0.5, drawing = false;
let draft = null, profile = null, hovered = -1, presses = [null, null], applied = [null, null];

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function status(message, extra = {}) {
  send("profile:status", { message, busy, ready: !!grids, hasProfile: !!profile, drawing, ...extra });
}

function instructions(text) { send("profile:instructions", text); }

// ----- loading ------------------------------------------------------------------------------
async function startLoad() {
  if (busy) return;
  token = { cancelled: false };
  const current = token;
  busy = true;
  const folder = path.join(temporary, String(++generation));
  try {
    const sample = await ds.prepareSample(assets, options, current, (value, message) => status(message, { percent: value }));
    ds.checkCancel(current);
    ds.configureRuntime(sample);
    fs.mkdirSync(folder, { recursive: true });
    const message = "Reading numeric heights and preparing matching relief maps...";
    status(message, { percent: 0 });
    await new Promise(setImmediate);
    const loaded = ds.readGrids(sample, current);
    const reliefs = [];
    for (let band = 0; band < 4; band++) {
      reliefs.push(ds.writeRgb(path.join(folder, `relief-${band}.tif`), loaded.width, loaded.height, loaded.transform, loaded.projection, ps.relief(loaded, band, current)));
      status(message, { percent: (band + 1) * 25 });
      await new Promise(setImmediate); // let the status and a cancel request through
      ds.checkCancel(current);
    }
    publish(loaded, reliefs);
    busy = false;
    exampleProfile();
    status(READY);
  } catch (error) {
    busy = false;
    const cancelled = error instanceof ds.Cancelled || current.cancelled;
    status(cancelled ? "Loading cancelled." : error.message);
    if (!closeQueued && !cancelled && window) dialog.showMessageBox(window, { type: "warning", title: "Unable to load sample", message: error.message });
  }
  if (closeQueued) setImmediate(() => window?.close());
}

/** DSM relief left; all three estimate reliefs right with one visible. */
function publish(loaded, reliefs) {
  grids = loaded;
  maps.forEach((map, pane) => {
    map.clearShapes();
    map.clearLayers();
    // The empty map adopts the first layer's CRS (EPSG:2056); new layers go to index 0.
    for (const band of pane === 0 ? [0] : [1, 2, 3]) map.addLayer(reliefs[band], ps.SURFACE_NAMES[band]);
    if (map.layerCount() !== (pane === 0 ? 1 : 3)) throw new Error("The relief layers were not added.");
    map.setTool(TOOL.pan);
  });
  applied = [null, null];
  fullExtent();
  selectSurface(surface);
}

function cancel() {
  token.cancelled = true;
  status("Cancelling loading...");
}

// ----- maps ---------------------------------------------------------------------------------
const rightIndex = (band) => 3 - band; // bands 1, 2, 3 were prepended in that order

function fullExtent() {
  maps[0].setExtent(FULL_EXTENT);
  syncFrom(0);
}

function syncFrom(side) {
  const other = 1 - side;
  applied[side] = maps[side].getExtent();
  if (!applied[side]) return;
  maps[other].setExtent(applied[side]);
  applied[other] = maps[other].getExtent();
}

const same = (a, b) => a && b && ["xMin", "yMin", "xMax", "yMax"].every((k) => Math.abs(a[k] - b[k]) < 1e-9);

function selectSurface(choice) {
  surface = choice;
  if (!grids) return;
  for (let band = 1; band <= 3; band++) maps[1].setLayerVisible(rightIndex(band), band === choice);
  maps[1].refresh();
  send("profile:heading", HEADINGS[choice - 1]);
}

function useTool(name) {
  setDrawing(false);
  for (const map of maps) map.setTool(TOOL[name]);
}

/** Native owned shapes on both maps: white halo + teal line, A teal and B orange markers.
 *  No A/B text labels: the runtime removes them with deleteLater, which never runs when the
 *  host pumps processEvents instead of a Qt event loop, so removed labels would reappear. */
function drawTransect() {
  const marker = (color) => ({ pointColor: color, pointSize: 18, lineColor: "#ffffff", lineWidth: 2 });
  for (const map of maps) {
    map.clearShapes();
    if (draft) map.addPoint(draft[0], draft[1], marker(COLORS[1]));
    else if (profile) {
      const line = [profile.start, profile.end];
      map.addLine(line, { lineColor: "#ffffff", lineWidth: 5 });
      map.addLine(line, { lineColor: COLORS[1], lineWidth: 2.5 });
      map.addPoint(profile.start[0], profile.start[1], marker(COLORS[1]));
      map.addPoint(profile.end[0], profile.end[1], marker(COLORS[3]));
    }
    map.refresh(); // owned shapes are drawn on the next full map render
  }
  drawCursor();
}

/** The chart's hovered sample as a lightweight overlay point (no map re-render). The point is
 *  parked far outside the map instead of removed: removal is deferred to a Qt event loop this
 *  host never runs, and a removed point would reappear on the next view change. */
function drawCursor() {
  const s = !draft && profile && hovered >= 0 && hovered < profile.samples.length ? profile.samples[hovered] : { x: -1e9, y: -1e9 };
  for (const map of maps) map.setOverlayPoint("cursor", s.x, s.y, { pointColor: "#dd3470", pointSize: 11, lineColor: "#ffffff", lineWidth: 2 });
}

function handleEvents() {
  const queued = events;
  events = [];
  for (const { side, e } of queued) {
    if (!grids) continue;
    if (e.type === EVENT.VISIBLE_EXTENT_CHANGED) {
      if (!same(applied[side], maps[side].getExtent())) syncFrom(side);
    } else if (e.type === EVENT.MAP_MOUSE_DOWN && e.int2 === 1) {
      presses[side] = [e.screen.left, e.screen.top];
    } else if (e.type === EVENT.MAP_MOUSE_UP && e.int2 === 1) {
      const press = presses[side];
      presses[side] = null;
      // A click (not a pan drag) picks a point; dragging still pans.
      if (press && Math.abs(press[0] - e.screen.left) + Math.abs(press[1] - e.screen.top) <= 3) pick(e.extent.xMin, e.extent.yMin);
    }
  }
}

// ----- transect -----------------------------------------------------------------------------
function setDrawing(on) {
  if (drawing === on && !draft) return;
  drawing = on;
  draft = null;
  if (on) { for (const map of maps) map.setTool(TOOL.pan); instructions("Click A on either map. Dragging still pans; wheel zooms."); }
  else instructions("Draw a new A → B transect, or inspect the current profile.");
  drawTransect();
  status(READY);
}

function pick(x, y) {
  if (!grids || busy || !drawing) return;
  if (ps.height(grids, 0, x, y) === null) { status("Click inside the valid raster pixel centres."); return; }
  if (!draft) {
    draft = [x, y];
    instructions("A selected. Click B on either map. Toggle Draw off to cancel.");
    drawTransect();
    return;
  }
  const a = draft;
  draft = null;
  try { commitProfile(a, [x, y]); }
  catch (error) { draft = a; status(error.message); return; }
  drawing = false;
  instructions("Your transect is ready. Hover over the chart to locate matching heights on both maps.");
  status(READY);
}

function exampleProfile() {
  if (!grids) return;
  drawing = false;
  draft = null;
  const [a, b] = ps.exampleEndpoints(grids);
  commitProfile(a, b);
  instructions("Example transect loaded. Select Draw transect, then click A and B to compare your own line.");
  status(READY);
}

function clearProfile() {
  drawing = false;
  draft = null;
  profile = null;
  hovered = -1;
  sendProfile();
  drawTransect();
  status(READY);
}

function commitProfile(a, b) {
  profile = ps.makeProfile(grids, a, b, spacing);
  hovered = -1;
  sendProfile();
  drawTransect();
}

function sendProfile() {
  send("profile:profile", profile && {
    length: profile.length, spacing: profile.spacing, rmse: profile.rmse, mae: profile.mae,
    samples: profile.samples.map((s) => [s.distance, s.x, s.y, ...s.heights]),
  });
}

async function exportCsv() {
  if (!profile || !grids) return;
  const current = profile;
  const result = await dialog.showSaveDialog(window, { title: "Export numeric profile", defaultPath: "profile.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (result.canceled || !result.filePath) return;
  try { ps.exportProfile(result.filePath, current, grids, assets.sha256); }
  catch (error) { dialog.showMessageBox(window, { type: "warning", title: "Export profile", message: error.message }); return; }
  status("Saved numeric profile CSV and metadata sidecar.");
}

function layout() {
  if (!window || !rects || !maps.length) return;
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  rects.forEach((rect, i) => maps[i].place(Math.round(rect.x * scale), Math.round(rect.y * scale), Math.round(rect.width * scale), Math.round(rect.height * scale)));
}

// ----- window -------------------------------------------------------------------------------
function action(name, value) {
  if (name === "layout" && Array.isArray(value) && value.length === 2) { rects = value; layout(); return; }
  if (name === "retry") { startLoad(); return; }
  if (name === "cancel") { cancel(); return; }
  if (!grids || busy) return;
  if (name === "surface" && [1, 2, 3].includes(value)) selectSurface(value);
  else if (name === "spacing" && Number.isFinite(value) && value >= 0.5 && value <= 10) {
    spacing = value;
    if (profile) { try { commitProfile(profile.start, profile.end); } catch (error) { status(error.message); } }
  }
  else if (name === "draw" && typeof value === "boolean") setDrawing(value);
  else if (name === "tool" && value in TOOL) useTool(value);
  else if (name === "zoom" && value === "in") maps[0].zoomIn(1.5);
  else if (name === "zoom" && value === "out") maps[0].zoomOut(1.5);
  else if (name === "zoom" && value === "full") fullExtent();
  else if (name === "example") exampleProfile();
  else if (name === "clear") clearProfile();
  else if (name === "hover" && Number.isInteger(value)) { hovered = value; drawCursor(); }
  else if (name === "export") exportCsv();
}

async function start() {
  options = ds.parseOptions(process.argv.slice(3));
  assets = ds.readAssets();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-dsm-profile-"));
  window = new BrowserWindow({
    width: 1460, height: 940, minWidth: 1000, minHeight: 700,
    title: "DSM to DTM | Interactive elevation profile — GeoKernel", backgroundColor: "#f2f6f8",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("profile:action", (event, name, value) => {
    if (!window || !maps.length || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try { action(name, value); } catch (error) { status(error.message); }
  });
  window.on("resize", layout);
  window.on("close", (event) => {
    if (busy) { event.preventDefault(); closeQueued = true; cancel(); return; }
    stop();
  });
  window.on("closed", () => { window = null; ipcMain.removeHandler("profile:action"); require("electron").app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  pump();
  const parent = koffi.decode(window.getNativeWindowHandle(), "void *");
  maps = [0, 1].map((side) => new Map2D(parent, (e) => events.push({ side, e })));
  layout();
  timer = setInterval(() => {
    if (!maps.length) return;
    pump();
    try { handleEvents(); } catch (error) { status(error.message); }
  }, 16);
  send("profile:init", {});
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
