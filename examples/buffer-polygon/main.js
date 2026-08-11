"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, extentInflate, findBinDir } = require("geokernel-electron");

const SOURCE = Object.freeze([
  [-3.6, -1.7], [-1.5, -2.2], [0.1, -1.1], [2.9, -1.5], [3.6, 0.6],
  [1.1, 2.1], [-0.9, 1.2], [-3.0, 1.8], [-4.0, 0.0], [-3.6, -1.7],
]);
const SOURCE_EXTENT = extent(-4.0, -2.2, 3.6, 2.1);
const FULL_EXTENT = extent(-6.0, -4.0, 6.0, 4.0);
const CONTROL = Object.freeze({ DISTANCE: 1, FULL_EXTENT: 2 });
const BUFFER_STYLE = Object.freeze({ fillColor: "#86D0A8", fillOpacity: 95, lineColor: "#2D6A4F", lineWidth: 2.0 });
const POLYGON_STYLE = Object.freeze({ fillColor: "#F9C74F", fillOpacity: 145, lineColor: "#D95D39", lineWidth: 2.4 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let updateScheduled = false;
let distance = 0.6;

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

function extentText(value) {
  return `(${value.xMin.toFixed(2)}, ${value.yMin.toFixed(2)}) - (${value.xMax.toFixed(2)}, ${value.yMax.toFixed(2)})`;
}

function updateBuffer() {
  viewer.clearShapes();
  const bufferCreated = viewer.addPolygonBufferShape(SOURCE, distance, 12, BUFFER_STYLE);
  if (!viewer.addPolygonShape(SOURCE, POLYGON_STYLE)) throw new Error("Source polygon shape could not be created.");

  viewer.clearLog();
  if (!bufferCreated) {
    viewer.appendLog(`MakeBuffer(polygon, ${distance.toFixed(2)}) returned an empty shape.`);
    viewer.setStatusText("Empty buffer result");
  } else {
    viewer.appendLog([
      "MakeBuffer(polygon, distance)", "Source parts: 1", `Source vertices: ${SOURCE.length}`,
      `Distance: ${distance.toFixed(2)} map units`, "Result type: polygon", "Result parts: 1",
      `Source extent: ${extentText(SOURCE_EXTENT)}`,
      `Result extent: ${extentText(extentInflate(SOURCE_EXTENT, distance, distance))}`,
      "Segments per quadrant: 12",
    ].join("\n"));
    viewer.setStatusText(`Polygon buffer distance: ${distance.toFixed(2)} map units`);
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
      viewer.setStatusText(`Polygon buffer failed: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "Buffer Polygon", width: 980, height: 680, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Polygon buffer",
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
