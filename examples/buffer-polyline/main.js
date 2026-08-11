"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const SOURCE = Object.freeze([
  [-4.6, -1.5], [-2.8, 0.4], [-1.0, -0.8], [0.7, 1.2], [2.5, 0.1], [4.4, 1.6],
]);
const FULL_EXTENT = extent(-5.8, -3.2, 5.8, 3.4);
const CONTROL = Object.freeze({ DISTANCE: 1, FULL_EXTENT: 2 });
const BUFFER_STYLE = Object.freeze({ fillColor: "#F9C74F", fillOpacity: 105, lineColor: "#D95D39", lineWidth: 2.0 });
const LINE_STYLE = Object.freeze({
  fillColor: "#FFFFFF", fillOpacity: 0, lineColor: "#1E5678",
  lineWidth: 3.0, pointColor: "#1E5678", pointSize: 8.0,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let updateScheduled = false;
let distance = 0.55;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function bufferExtent(value) {
  const xs = SOURCE.map((point) => point[0]);
  const ys = SOURCE.map((point) => point[1]);
  return extent(Math.min(...xs) - value, Math.min(...ys) - value, Math.max(...xs) + value, Math.max(...ys) + value);
}

function extentText(value) {
  return `(${value.xMin.toFixed(2)}, ${value.yMin.toFixed(2)}) - (${value.xMax.toFixed(2)}, ${value.yMax.toFixed(2)})`;
}

function updateBuffer() {
  viewer.clearShapes();
  const bufferCreated = viewer.addPolylineBufferShape(SOURCE, distance, 12, BUFFER_STYLE);
  if (!viewer.addPolylineShape(SOURCE, LINE_STYLE)) throw new Error("Source polyline shape could not be created.");

  viewer.clearLog();
  if (!bufferCreated) {
    viewer.appendLog(`MakeBuffer(polyline, ${distance.toFixed(2)}) returned an empty shape.`);
    viewer.setStatusText("Empty buffer result");
  } else {
    viewer.appendLog([
      "MakeBuffer(polyline, distance)", "Source parts: 1", `Source vertices: ${SOURCE.length}`,
      `Distance: ${distance.toFixed(2)} map units`, "Result type: polygon", "Result parts: 1",
      `Result extent: ${extentText(bufferExtent(distance))}`, "Segments per quadrant: 12",
    ].join("\n"));
    viewer.setStatusText(`Polyline buffer distance: ${distance.toFixed(2)} map units`);
  }
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function scheduleBufferUpdate() {
  if (updateScheduled) return;
  updateScheduled = true;
  setImmediate(() => {
    updateScheduled = false;
    if (!viewer) return;
    try { updateBuffer(); }
    catch (error) {
      viewer.setStatusText(`Polyline buffer failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onControlChanged(controlId, numericValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.DISTANCE) {
    distance = Math.max(0.1, Math.min(2.0, Number(numericValue)));
    scheduleBufferUpdate();
  } else if (controlId === CONTROL.FULL_EXTENT) viewer.setViewExtent(FULL_EXTENT);
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { viewerWasVisible = true; viewerHiddenSince = 0; }
    else if (viewerWasVisible) {
      if (viewerHiddenSince === 0) viewerHiddenSince = Date.now();
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "Buffer Polyline", width: 980, height: 680, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Polyline buffer",
    width: 240,
    controls: [
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      { id: CONTROL.DISTANCE, type: "number", label: "Distance", value: distance, minimum: 0.1, maximum: 2.0, step: 0.1, decimals: 2, suffix: " units" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Buffer details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  controlsReady = true;
  updateBuffer();
  viewer.setViewExtent(FULL_EXTENT);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  updateScheduled = false;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
