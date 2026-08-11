"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { TopologyFixOperation, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const SOURCE_PARTS = [
  [[-5.2, -1.3], [-4.0, -0.2], [-4.0, -0.2], [-2.6, -1.1], [-1.2, 0.5], [-1.2, 0.5], [0.4, 0.1]],
  [[1.5, 1.0]],
  [[2.8, -0.8], [2.8, -0.8]],
  [[3.7, -1.1], [4.8, 0.3], [5.4, -0.9]],
];
const OPERATIONS = Object.freeze({
  "FixShape": TopologyFixOperation.FIX_SHAPE,
  "FixShapeEx (preserve empty parts)": TopologyFixOperation.FIX_SHAPE_EX,
  "ClearShape": TopologyFixOperation.CLEAR_SHAPE,
});
const FULL_EXTENT = extent(-5.9, -2.4, 5.9, 1.8);
const CONTROL_OPERATION = 1;

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let operationName = "FixShape";

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

function normalizeParts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => Array.isArray(part)
    ? part.map((point) => [Number(point.x ?? point[0]), Number(point.y ?? point[1])])
    : []).filter((part) => part.length > 0);
}

function addParts(parts, color, width) {
  parts.forEach((part) => {
    if (part.length >= 2 && !viewer.addPolylineShape(part, { lineColor: color, lineWidth: width })) {
      throw new Error("Polyline shape could not be rendered.");
    }
  });
}

function renderResult(preserveExtent = true) {
  const currentExtent = preserveExtent ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  addParts(SOURCE_PARTS, "#6C757D", 2.0);
  const result = normalizeParts(viewer.fixPolyline(SOURCE_PARTS, OPERATIONS[operationName]));
  addParts(result, "#D95D39", 4.0);
  viewer.clearLog();
  viewer.appendLog([
    "Topology fix functions", "", "Source: messy multipart polyline",
    "- part 1 has duplicate consecutive vertices",
    "- part 2 has only one vertex",
    "- part 3 collapses after duplicate cleanup",
    "- part 4 is already valid", "",
    `Source parts: ${SOURCE_PARTS.length}`,
    `Source vertices: ${SOURCE_PARTS.reduce((sum, part) => sum + part.length, 0)}`, "",
    `Operation: ${operationName}`,
    `Result parts: ${result.length}`,
    `Result vertices: ${result.reduce((sum, part) => sum + part.length, 0)}`,
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(currentExtent ?? FULL_EXTENT);
  viewer.setStatusText(`${operationName} applied.`);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!controlsReady || controlId !== CONTROL_OPERATION || !Object.hasOwn(OPERATIONS, textValue)) return;
  operationName = textValue;
  try { renderResult(true); }
  catch (error) {
    viewer.setStatusText(`TopologyFix failed: ${error.message}`);
    console.error(error?.stack || error);
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
  viewer = new ViewerWindow({ title: "TopologyFix", width: 980, height: 680, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Topology fix",
    width: 285,
    controls: [{ id: CONTROL_OPERATION, type: "combo", label: "Operation", options: Object.keys(OPERATIONS), value: operationName }],
  }, onControlChanged);
  viewer.addLogPanel("TopologyFix details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  controlsReady = true;
  renderResult(false);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
