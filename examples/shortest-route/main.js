"use strict";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/stockholm.zip";
const CONTROL = Object.freeze({ SELECT: 1 });
let viewer = null; let keeperWindow = null; let eventPump = null; let worker = null;
let visibleOnce = false; let hiddenSince = 0; let closing = false; let ready = false; let selecting = false;
let sequence = 0; let pending = 0; let pendingSelectsStart = false; let startNode = null;
let startPoint = null; let finishPoint = null; let startSnap = 0; let route = null;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null, path.join(binDir, "platforms", "qwindows.dll"), path.join(binDir, "plugins", "platforms", "qwindows.dll")].filter(Boolean);
  if (!candidates.some(fs.existsSync)) throw new Error(`Qt platform plugin is missing: ${binDir}`);
}

function draw() {
  if (!viewer) return;
  viewer.clearShapes();
  if (route) viewer.addPolylineShape(route.geometry, { lineColor: "#EF4444", lineOpacity: 255, lineWidth: 4 });
  if (startPoint) viewer.addPointShape(startPoint.x, startPoint.y, { pointColor: "#22C55E", lineColor: "#14532D", pointSize: 16, lineWidth: 2 });
  if (finishPoint) viewer.addPointShape(finishPoint.x, finishPoint.y, { pointColor: "#EF4444", lineColor: "#7F1D1D", pointSize: 16, lineWidth: 2 });
  viewer.invalidateRenderCache(false, true); viewer.refreshLayers();
}

function beginSelection() {
  if (!ready || !viewer) return;
  startNode = null; startPoint = null; finishPoint = null; route = null; selecting = false;
  viewer.clearShapes(); viewer.clearLog(); viewer.setTool(ViewerTool.ROUTE); viewer.setStatusText("Click the map to choose the start point."); viewer.refreshLayers();
}

function showRoute() {
  viewer.clearLog();
  viewer.appendLog(`${(route.distance / 1000).toFixed(2)} km  •  ${(route.time / 60).toFixed(1)} min\n`);
  route.steps.forEach((step, index) => { const value = step.distance >= 1000 ? `${(step.distance / 1000).toFixed(1)} km` : `${step.distance.toFixed(0)} m`; viewer.appendLog(`${index + 1}. ${step.name}\n    ${value}`); });
  if (!route.steps.length) viewer.appendLog("Route has no named road segments.");
  draw();
}

function requestSelection(event) {
  if (!ready || selecting || event.intValue !== ViewerTool.ROUTE) return;
  const world = viewer.screenToWorld(event.screenRectangle.left, event.screenRectangle.top); if (!world) return;
  const point = viewer.transformPoint(3857, 4326, world.x, world.y); selecting = true; pending = ++sequence;
  pendingSelectsStart = startNode == null || finishPoint != null;
  viewer.setStatusText(pendingSelectsStart ? "Snapping the start point..." : "Calculating shortest route...");
  worker.send({ type: "select", id: pending, point, start: pendingSelectsStart ? null : startNode });
}

function handleWorker(message) {
  if (!viewer || closing) return;
  if (message.type === "ready") { ready = true; beginSelection(); return; }
  if (message.type === "error") { selecting = false; viewer.setStatusText(message.message); console.error(message.message); return; }
  if (message.type !== "selection" || message.id !== pending) return;
  selecting = false;
  if (!message.snapped) { viewer.setStatusText("No road node was found near the selected point."); return; }
  if (pendingSelectsStart) {
    startNode = message.snapped.id; startPoint = message.snapped.world; startSnap = message.snapped.distance; finishPoint = null; route = null;
    viewer.clearLog(); draw(); viewer.setStatusText("Start selected. Click the map to choose the finish point."); return;
  }
  finishPoint = message.snapped.world; route = message.route; draw();
  if (!route) { viewer.setStatusText("No connected route found. Click once to choose a new start."); return; }
  showRoute(); viewer.setStatusText(`Route: ${(route.distance / 1000).toFixed(2)} km, ${(route.time / 60).toFixed(1)} min | start snap ${startSnap.toFixed(1)} m, end snap ${message.snapped.distance.toFixed(1)} m`);
}

function startEventPump() {
  eventPump = setInterval(() => { if (!viewer) return; viewer.processEvents(); if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; } else if (visibleOnce) { if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 750) app.quit(); } }, 16);
}

async function start() {
  closing = false; verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "ShortestRoute", width: 1200, height: 760 });
  viewer.addCommandToolbar([{ id: CONTROL.SELECT, text: "Select route points" }], () => setImmediate(beginSelection));
  viewer.addControlPanel({ title: "Shortest route", area: "right", width: 300, controls: [{ id: CONTROL.SELECT, type: "button", text: "Select route points" }] }, (id) => { if (id === CONTROL.SELECT) setImmediate(beginSelection); });
  viewer.addLogPanel("Route directions");
  viewer.setEventCallback((event) => { if (event.eventType === ViewerEventType.MAP_MOUSE_UP) setImmediate(() => requestSelection(event)); });
  viewer.setTool(ViewerTool.PAN); viewer.setStatusText("Preparing Stockholm sample data..."); viewer.show(); viewer.processEvents(); startEventPump();
  const shapefile = await ensureSampleFile(SAMPLE_URL, "stockholm.zip", "stockholm", "stockholm.shp");
  if (!viewer) return;
  viewer.addLayer(shapefile); viewer.setLayerCoordinateSystemPreset(0, "EPSG:4326"); viewer.setCoordinateSystemPreset("EPSG:3857"); viewer.setLayerStyle(0, { lineColor: "#718684", lineWidth: 1 });
  const extent = viewer.layerProjectedExtent(0); if (extent) viewer.setViewExtent(extent); viewer.setStatusText("Preparing routing graph...");
  worker = fork(path.join(__dirname, "routing-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LOCALAPPDATA: path.join(app.getPath("temp"), "GeoKernelShortestRouteWorker") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data)); worker.on("message", handleWorker); worker.on("error", (error) => { viewer?.setStatusText(error.message); console.error(error.stack || error); }); worker.send({ type: "initialize", shapefile });
}

function stop() {
  closing = true; if (eventPump) clearInterval(eventPump); eventPump = null; worker?.kill(); worker = null;
  if (viewer) { try { viewer.close(); } catch { /* Native window may be gone. */ } } viewer = null; keeperWindow?.destroy(); keeperWindow = null;
}

module.exports = { start, stop };
