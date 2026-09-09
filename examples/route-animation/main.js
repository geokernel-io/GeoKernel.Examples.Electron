"use strict";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/stockholm.zip";
const COMMAND = Object.freeze({ SELECT: 1, PLAY: 2, PAUSE: 3, RESET: 4 });
const CONTROL = Object.freeze({ SELECT: 1, PLAY: 2, PAUSE: 3, RESET: 4, SUMMARY: 5, ANIMATION: 6 });

let viewer = null; let keeperWindow = null; let eventPump = null; let animationTimer = null; let worker = null;
let visibleOnce = false; let hiddenSince = 0; let closing = false; let ready = false; let selecting = false;
let sequence = 0; let pending = 0; let pendingSelectsStart = false; let startNode = null;
let startPoint = null; let finishPoint = null; let route = null; let progress = 0; let durationMs = 5000;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some(fs.existsSync)) throw new Error(`Qt platform plugin is missing: ${binDir}`);
}

function setEnabled(id, value) {
  viewer.setCommandEnabled(id, value);
  viewer.setControlEnabled(id, value);
}

function setSummary(value) { viewer.setControlValue(CONTROL.SUMMARY, value); }
function setAnimation(value) { viewer.setControlValue(CONTROL.ANIMATION, value); }

function vehiclePosition() {
  if (!route?.geometry || route.geometry.length < 2) return null;
  const lengths = [];
  let total = 0;
  for (let index = 1; index < route.geometry.length; index += 1) {
    const first = route.geometry[index - 1]; const last = route.geometry[index];
    const length = Math.hypot(last.x - first.x, last.y - first.y);
    lengths.push(length); total += length;
  }
  if (total <= 0) return null;
  const target = total * progress;
  let traversed = 0;
  for (let index = 1; index < route.geometry.length; index += 1) {
    const length = lengths[index - 1];
    if (target <= traversed + length || index === route.geometry.length - 1) {
      const ratio = length > 0 ? Math.max(0, Math.min(1, (target - traversed) / length)) : 0;
      const first = route.geometry[index - 1]; const last = route.geometry[index];
      return {
        point: { x: first.x + (last.x - first.x) * ratio, y: first.y + (last.y - first.y) * ratio },
        direction: last,
      };
    }
    traversed += length;
  }
  return null;
}

function draw() {
  if (!viewer) return;
  viewer.clearShapes();
  if (route) viewer.addPolylineShape(route.geometry, { lineColor: "#EF4444", lineOpacity: 255, lineWidth: 4 });
  if (startPoint) viewer.addPointShape(startPoint.x, startPoint.y, { pointColor: "#22C55E", lineColor: "#14532D", pointSize: 16, lineWidth: 2 });
  if (finishPoint) viewer.addPointShape(finishPoint.x, finishPoint.y, { pointColor: "#EF4444", lineColor: "#7F1D1D", pointSize: 16, lineWidth: 2 });
  drawVehicle();
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.processEvents();
}

function drawVehicle() {
  const vehicle = route && progress >= 0 ? vehiclePosition() : null;
  if (!vehicle) {
    viewer.removeOverlayShape("vehicle");
    return;
  }
  viewer.setOverlayPoint("vehicle", vehicle.point.x, vehicle.point.y, {
    pointColor: "#2563EB", lineColor: "#1E3A8A", pointSize: 20, lineWidth: 2,
  });
}

function stopAnimation() {
  if (animationTimer) clearInterval(animationTimer);
  animationTimer = null;
}

function disableAnimation() {
  stopAnimation(); progress = 0;
  setEnabled(COMMAND.PLAY, false); setEnabled(COMMAND.PAUSE, false); setEnabled(COMMAND.RESET, false);
  setAnimation("Animation is waiting for a route.");
}

function beginSelection() {
  if (!ready || !viewer) return;
  disableAnimation(); startNode = null; startPoint = null; finishPoint = null; route = null; selecting = false;
  viewer.clearLog(); setSummary("Select a start and finish point."); draw(); viewer.setTool(ViewerTool.ROUTE);
  viewer.setStatusText("Click the map to choose the start point.");
}

function showRoute() {
  viewer.clearLog();
  route.steps.forEach((step, index) => {
    const value = step.distance >= 1000 ? `${(step.distance / 1000).toFixed(1)} km` : `${step.distance.toFixed(0)} m`;
    viewer.appendLog(`${index + 1}. ${step.name}\n    ${value}`);
  });
  if (!route.steps.length) viewer.appendLog("Route has no named road segments.");
  setSummary(`${(route.distance / 1000).toFixed(2)} km  •  ${(route.time / 60).toFixed(1)} min`);
  setAnimation(`Ready: ${(route.distance / 1000).toFixed(2)} km • ${(route.time / 60).toFixed(1)} min`);
  draw();
}

function play() {
  if (!route || animationTimer) return;
  if (progress >= 1) progress = 0;
  setEnabled(COMMAND.PLAY, false); setEnabled(COMMAND.PAUSE, true);
  animationTimer = setInterval(() => {
    progress = Math.min(1, progress + 33 / durationMs);
    const remaining = 1 - progress;
    setAnimation(`Progress: ${(progress * 100).toFixed(0)}% | Remaining: ${(route.distance * remaining / 1000).toFixed(2)} km • ${(route.time * remaining / 60).toFixed(1)} min`);
    drawVehicle();
    if (progress >= 1) {
      stopAnimation(); setEnabled(COMMAND.PAUSE, false); setAnimation("Destination reached.");
    }
  }, 33);
}

function pause() {
  if (!route) return;
  stopAnimation(); setEnabled(COMMAND.PLAY, true); setEnabled(COMMAND.PAUSE, false);
}

function resetAnimation() {
  if (!route) return;
  stopAnimation(); progress = 0; setEnabled(COMMAND.PLAY, true); setEnabled(COMMAND.PAUSE, false);
  setAnimation(`Ready: ${(route.distance / 1000).toFixed(2)} km • ${(route.time / 60).toFixed(1)} min`); drawVehicle();
}

function requestSelection(event) {
  if (!ready || selecting || event.intValue !== ViewerTool.ROUTE) return;
  const world = viewer.screenToWorld(event.screenRectangle.left, event.screenRectangle.top);
  if (!world) return;
  selecting = true; pending = ++sequence; pendingSelectsStart = startNode == null || finishPoint != null;
  viewer.setStatusText(pendingSelectsStart ? "Snapping the start point..." : "Calculating route...");
  worker.send({ type: "select", id: pending, point: viewer.transformPoint(3857, 4326, world.x, world.y), start: pendingSelectsStart ? null : startNode });
}

function handleWorker(message) {
  if (!viewer || closing) return;
  if (message.type === "ready") { ready = true; setEnabled(COMMAND.SELECT, true); beginSelection(); return; }
  if (message.type === "error") { selecting = false; viewer.setStatusText(message.message); console.error(message.message); return; }
  if (message.type !== "selection" || message.id !== pending) return;
  selecting = false;
  if (!message.snapped) { viewer.setStatusText("No road node was found near the selected point."); return; }
  if (pendingSelectsStart) {
    disableAnimation(); startNode = message.snapped.id; startPoint = message.snapped.world; finishPoint = null; route = null;
    viewer.clearLog(); setSummary("Select the finish point."); draw(); viewer.setStatusText("Start selected. Click the map to choose the finish point."); return;
  }
  finishPoint = message.snapped.world; route = message.route;
  if (!route) { draw(); viewer.setStatusText("No connected route found. Click once to choose a new start."); return; }
  progress = 0; durationMs = Math.max(5000, Math.min(45000, route.time / 60 * 1000));
  setEnabled(COMMAND.PLAY, true); setEnabled(COMMAND.PAUSE, false); setEnabled(COMMAND.RESET, true);
  showRoute(); viewer.setStatusText(`Route: ${(route.distance / 1000).toFixed(2)} km, ${(route.time / 60).toFixed(1)} min`);
}

function onAction(id) {
  setImmediate(() => { if (id === COMMAND.SELECT) beginSelection(); else if (id === COMMAND.PLAY) play(); else if (id === COMMAND.PAUSE) pause(); else if (id === COMMAND.RESET) resetAnimation(); });
}

function startEventPump() {
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; }
    else if (visibleOnce) { if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 750) app.quit(); }
  }, 16);
}

async function start() {
  closing = false; verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "RouteAnimation", width: 1200, height: 760 });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Select route points", enabled: false },
    { id: COMMAND.PLAY, text: "Play", enabled: false },
    { id: COMMAND.PAUSE, text: "Pause", enabled: false },
    { id: COMMAND.RESET, text: "Reset", enabled: false },
  ], onAction);
  viewer.addControlPanel({ title: "Route animation", area: "right", width: 320, controls: [
    { id: CONTROL.SELECT, type: "button", text: "Select route points" },
    { id: CONTROL.SUMMARY, type: "text", label: "Route", value: "Select a start and finish point.", enabled: false },
    { id: CONTROL.ANIMATION, type: "text", label: "Animation", value: "Animation is waiting for a route.", enabled: false },
    { id: CONTROL.PLAY, type: "button", text: "Play" },
    { id: CONTROL.PAUSE, type: "button", text: "Pause" },
    { id: CONTROL.RESET, type: "button", text: "Reset" },
  ] }, onAction);
  [CONTROL.SELECT, CONTROL.PLAY, CONTROL.PAUSE, CONTROL.RESET].forEach((id) => viewer.setControlEnabled(id, false));
  viewer.addLogPanel("Route directions");
  viewer.setEventCallback((event) => { if (event.eventType === ViewerEventType.MAP_MOUSE_UP) setImmediate(() => requestSelection(event)); });
  viewer.setTool(ViewerTool.PAN); viewer.setStatusText("Preparing Stockholm sample data..."); viewer.show(); viewer.processEvents(); startEventPump();
  const shapefile = await ensureSampleFile(SAMPLE_URL, "stockholm.zip", "stockholm", "stockholm.shp");
  if (!viewer) return;
  viewer.addLayer(shapefile); viewer.setLayerCoordinateSystemPreset(0, "EPSG:4326"); viewer.setCoordinateSystemPreset("EPSG:3857"); viewer.setLayerStyle(0, { lineColor: "#718684", lineWidth: 1 });
  const extent = viewer.layerProjectedExtent(0); if (extent) viewer.setViewExtent(extent); viewer.setStatusText("Preparing routing graph...");
  worker = fork(path.join(__dirname, "routing-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LOCALAPPDATA: path.join(app.getPath("temp"), "GeoKernelRouteAnimationWorker") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data)); worker.on("message", handleWorker); worker.on("error", (error) => { viewer?.setStatusText(error.message); console.error(error.stack || error); }); worker.send({ type: "initialize", shapefile });
}

function stop() {
  closing = true; stopAnimation(); if (eventPump) clearInterval(eventPump); eventPump = null; worker?.kill(); worker = null;
  if (viewer) { try { viewer.clearOverlayShapes(); viewer.close(); } catch { /* Native window may be gone. */ } }
  viewer = null; keeperWindow?.destroy(); keeperWindow = null;
}

module.exports = { start, stop };
