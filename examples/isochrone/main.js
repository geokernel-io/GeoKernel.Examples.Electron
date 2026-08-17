"use strict";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/stockholm.zip";
const CONTROL = Object.freeze({ SELECT: 1, SUMMARY: 2, BAND: 3, HELP: 4 });
const BAND_NAMES = ["Within 5 minutes", "Within 10 minutes", "Within 15 minutes"];
const LAYER_NAMES = ["Isochrone 0-5 min", "Isochrone 5-10 min", "Isochrone 10-15 min"];
const COLORS = ["#16A34A", "#F59E0B", "#DC2626"];

let viewer = null; let keeperWindow = null; let eventPump = null; let worker = null;
let visibleOnce = false; let hiddenSince = 0; let closing = false; let ready = false; let busy = false;
let sequence = 0; let pending = 0; let result = null;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null, path.join(binDir, "platforms", "qwindows.dll"), path.join(binDir, "plugins", "platforms", "qwindows.dll")].filter(Boolean);
  if (!candidates.some(fs.existsSync)) throw new Error(`Qt platform plugin is missing: ${binDir}`);
}

function clearBandLayers() { for (const name of LAYER_NAMES) viewer?.removeLayerByName(name); }

function beginSelection() {
  if (!ready || busy || !viewer) return;
  result = null;
  clearBandLayers();
  viewer.clearShapes();
  viewer.setControlValue(CONTROL.SUMMARY, "Select an origin point.");
  viewer.setControlOptions(CONTROL.BAND, []);
  viewer.setControlEnabled(CONTROL.BAND, false);
  viewer.setTool(ViewerTool.ROUTE);
  viewer.setStatusText("Click the map to choose an isochrone origin.");
  viewer.invalidateRenderCache(false, true); viewer.refreshLayers();
}

function applyBandStyle(active) {
  if (!viewer || !result) return;
  for (let band = 0; band < 3; band += 1) {
    const index = Number(viewer.layerInfoByName(LAYER_NAMES[band])?.index ?? -1);
    if (index >= 0) viewer.setLayerStyle(index, {
      lineColor: COLORS[band], lineOpacity: band === active ? 250 : 135,
      lineWidth: band === active ? 4.5 : 2.5,
    });
  }
  viewer.invalidateRenderCache(false, true); viewer.refreshLayers();
}

function drawResult(active = 0) {
  if (!viewer || !result) return;
  clearBandLayers();
  for (let band = 2; band >= 0; band -= 1) {
    viewer.addPolylineLayer(LAYER_NAMES[band], result.bands[band].parts, {
      lineColor: COLORS[band], lineOpacity: band === active ? 250 : 135,
      lineWidth: band === active ? 4.5 : 2.5,
    });
  }
  viewer.clearShapes();
  viewer.addPointShape(result.origin.x, result.origin.y, {
    pointColor: "#22C55E", lineColor: "#14532D", pointSize: 18, lineWidth: 2,
  });
  viewer.invalidateRenderCache(false, true); viewer.refreshLayers();
}

function requestCalculation(event) {
  if (!ready || busy || event.intValue !== ViewerTool.ROUTE) return;
  const world = viewer.screenToWorld(event.screenRectangle.left, event.screenRectangle.top);
  if (!world) return;
  busy = true; pending = ++sequence;
  viewer.setCommandEnabled(1, false); viewer.setControlEnabled(CONTROL.SELECT, false);
  viewer.setStatusText("Calculating isochrone...");
  worker.send({ type: "calculate", id: pending, point: viewer.transformPoint(3857, 4326, world.x, world.y) });
}

function handleWorker(message) {
  if (!viewer || closing) return;
  if (message.type === "ready") { ready = true; viewer.setCommandEnabled(1, true); viewer.setControlEnabled(CONTROL.SELECT, true); beginSelection(); return; }
  if (message.type === "error") { busy = false; viewer.setCommandEnabled(1, ready); viewer.setControlEnabled(CONTROL.SELECT, ready); viewer.setStatusText(message.message); console.error(message.message); return; }
  if (message.type !== "result" || message.id !== pending) return;
  busy = false; viewer.setCommandEnabled(1, true); viewer.setControlEnabled(CONTROL.SELECT, true);
  if (!message.result) { viewer.setStatusText("No main-network road node was found nearby."); return; }
  result = message.result;
  const options = result.bands.map((band, index) => `${BAND_NAMES[index]} — ${band.cumulativeNodes} nodes • ${band.edgeCount} edges`);
  viewer.setControlOptions(CONTROL.BAND, options); viewer.setControlEnabled(CONTROL.BAND, true); viewer.setControlValue(CONTROL.BAND, options[0]);
  viewer.setControlValue(CONTROL.SUMMARY, `Origin snap: ${result.snapDistance.toFixed(1)} m | ${result.bands[2].cumulativeNodes} nodes reachable within 15 minutes.`);
  drawResult(0); viewer.setStatusText("Isochrone calculated successfully.");
}

function onControl(id, _number, text) {
  setImmediate(() => {
    if (id === CONTROL.SELECT) beginSelection();
    else if (id === CONTROL.BAND && result) {
      const index = result.bands.map((band, bandIndex) => `${BAND_NAMES[bandIndex]} — ${band.cumulativeNodes} nodes • ${band.edgeCount} edges`).indexOf(text);
      if (index >= 0) applyBandStyle(index);
    }
  });
}

function startEventPump() {
  eventPump = setInterval(() => {
    if (!viewer) return; viewer.processEvents();
    if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; }
    else if (visibleOnce) { if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 750) app.quit(); }
  }, 16);
}

async function start() {
  closing = false; verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "Isochrone", width: 1200, height: 760 });
  viewer.addCommandToolbar([{ id: 1, text: "Select isochrone origin", enabled: false }], () => setImmediate(beginSelection));
  viewer.addControlPanel({ title: "Travel-time isochrone", area: "right", width: 310, controls: [
    { id: CONTROL.SELECT, type: "button", text: "Select isochrone origin", enabled: false },
    { id: CONTROL.SUMMARY, type: "text", label: "Summary", value: "Select an origin point.", readOnly: true },
    { id: CONTROL.BAND, type: "combo", label: "Isochrone bands", options: [], enabled: false },
    { id: CONTROL.HELP, type: "text", label: "Legend", value: "Green: 0–5 min | Orange: 5–10 min | Red: 10–15 min", readOnly: true },
  ] }, onControl);
  viewer.setEventCallback((event) => { if (event.eventType === ViewerEventType.MAP_MOUSE_UP) setImmediate(() => requestCalculation(event)); });
  viewer.setTool(ViewerTool.PAN); viewer.setStatusText("Preparing Stockholm sample data..."); viewer.show(); viewer.processEvents(); startEventPump();
  const shapefile = await ensureSampleFile(SAMPLE_URL, "stockholm.zip", "stockholm", "stockholm.shp");
  if (!viewer) return;
  viewer.addLayer(shapefile); viewer.setLayerCoordinateSystemPreset(0, "EPSG:4326"); viewer.setCoordinateSystemPreset("EPSG:3857"); viewer.setLayerStyle(0, { lineColor: "#718684", lineWidth: 1 });
  const mapExtent = viewer.layerProjectedExtent(0); if (mapExtent) viewer.setViewExtent(mapExtent);
  viewer.setStatusText("Preparing routing graph...");
  worker = fork(path.join(__dirname, "routing-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LOCALAPPDATA: path.join(app.getPath("temp"), "GeoKernelIsochroneWorker") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data)); worker.on("message", handleWorker); worker.on("error", (error) => { viewer?.setStatusText(error.message); console.error(error.stack || error); }); worker.send({ type: "initialize", shapefile });
}

function stop() {
  closing = true; if (eventPump) clearInterval(eventPump); eventPump = null; worker?.kill(); worker = null;
  if (viewer) { try { viewer.close(); } catch { /* Native window may be gone. */ } } viewer = null; keeperWindow?.destroy(); keeperWindow = null;
}

module.exports = { start, stop };
