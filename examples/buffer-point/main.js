"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const FULL_EXTENT = extent(-5.0, -4.0, 5.0, 4.0);
const SOURCE_POINT = Object.freeze({ x: 0.0, y: 0.0 });
const CONTROL = Object.freeze({ DISTANCE: 1, FULL_EXTENT: 2 });
const BUFFER_STYLE = Object.freeze({ fillColor: "#78B7D0", fillOpacity: 85, lineColor: "#1E6F8C", lineWidth: 2.0 });
const POINT_STYLE = Object.freeze({
  fillColor: "#D95D39", fillOpacity: 255, lineColor: "#7A2F1E",
  lineWidth: 1.3, pointColor: "#D95D39", pointSize: 13.0,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let updateScheduled = false;
let distance = 2.0;

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

function updateBuffer() {
  viewer.clearShapes();
  const bufferCreated = viewer.addPointBufferShape(
    SOURCE_POINT.x,
    SOURCE_POINT.y,
    distance,
    16,
    BUFFER_STYLE,
  );
  if (!viewer.addPointShape(SOURCE_POINT.x, SOURCE_POINT.y, POINT_STYLE)) {
    throw new Error("Source point shape could not be created.");
  }

  viewer.clearLog();
  if (!bufferCreated) {
    viewer.appendLog(`MakeBuffer(point, ${distance.toFixed(2)}) returned an empty shape.`);
    viewer.setStatusText("Empty buffer result");
  } else {
    viewer.appendLog([
      "MakeBuffer(point, distance)",
      `Source point: (${SOURCE_POINT.x.toFixed(2)}, ${SOURCE_POINT.y.toFixed(2)})`,
      `Distance: ${distance.toFixed(2)} map units`,
      "Result type: polygon",
      "Result parts: 1",
      `Result extent: (${(-distance).toFixed(2)}, ${(-distance).toFixed(2)}) - (${distance.toFixed(2)}, ${distance.toFixed(2)})`,
      "Segments per quadrant: 16",
    ].join("\n"));
    viewer.setStatusText(`Point buffer distance: ${distance.toFixed(2)} map units`);
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
      viewer.setStatusText(`Point buffer failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onControlChanged(controlId, numericValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.DISTANCE) {
    distance = Math.max(0.25, Math.min(5.0, Number(numericValue)));
    scheduleBufferUpdate();
  } else if (controlId === CONTROL.FULL_EXTENT) {
    viewer.setViewExtent(FULL_EXTENT);
  }
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
  viewer = new ViewerWindow({ title: "Buffer Point", width: 980, height: 680, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Point buffer",
    width: 240,
    controls: [
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      { id: CONTROL.DISTANCE, type: "number", label: "Distance", value: distance, minimum: 0.25, maximum: 5.0, step: 0.25, decimals: 2, suffix: " units" },
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
