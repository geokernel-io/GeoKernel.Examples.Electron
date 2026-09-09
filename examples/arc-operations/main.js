"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const FIND_QUERY = [[-5.2, 2.2], [-3.2, 2.2]];
const FIND_CANDIDATES = [[[-1.8, 2.7], [0.4, 2.7]], [[-5.2, 2.2], [-3.2, 2.2]]];
const CONNECT_BASE = [[-5.2, 0.2], [-3.6, 0.2], [-2.6, 0.8]];
const CONNECT_CONTINUATION = [[-2.6, 0.8], [-1.1, 0.1], [0.4, 0.4]];
const SPLIT_ARC = [[-5.2, -2.0], [-1.0, -2.0]];
const SPLIT_CUTTER = [[-3.1, -3.0], [-3.1, -1.0]];
const RESULT_COLORS = ["#D95D39", "#2A9D8F", "#7B2CBF"];
const FULL_EXTENT = extent(-5.8, -3.3, 1.0, 3.2);

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

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

function extentText(points) {
  const xs = points.map((point) => Number(point.x ?? point[0]));
  const ys = points.map((point) => Number(point.y ?? point[1]));
  return `(${Math.min(...xs).toFixed(2)}, ${Math.min(...ys).toFixed(2)}) - (${Math.max(...xs).toFixed(2)}, ${Math.max(...ys).toFixed(2)})`;
}

function normalizeParts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => Array.isArray(part)
    ? part.map((point) => [Number(point.x ?? point[0]), Number(point.y ?? point[1])])
    : []).filter((part) => part.length > 0);
}

function addLine(points, color, width) {
  if (!viewer.addPolylineShape(points, { lineColor: color, lineWidth: width })) {
    throw new Error("Polyline shape could not be rendered.");
  }
}

function addSources() {
  FIND_CANDIDATES.forEach((candidate) => addLine(candidate, "#6C757D", 2.0));
  addLine(FIND_QUERY, "#2F80C2", 3.0);
  addLine(CONNECT_BASE, "#6C757D", 2.0);
  addLine(CONNECT_CONTINUATION, "#6C757D", 2.0);
  addLine(SPLIT_ARC, "#2F80C2", 3.0);
  addLine(SPLIT_CUTTER, "#212529", 2.6);
}

function addResults(details) {
  const foundIndex = viewer.findMatchingArcIndex(FIND_QUERY, FIND_CANDIDATES);
  const found = foundIndex >= 0;
  details.push("", `ArcFind result: ${found ? "found" : "not found"}, index: ${foundIndex}`);
  if (found) addLine(FIND_CANDIDATES[foundIndex], RESULT_COLORS[0], 4.0);

  const connected = normalizeParts(viewer.arcMakeConnected(CONNECT_BASE, [CONNECT_CONTINUATION]));
  details.push(`ArcMakeConnected result parts: ${connected.length}, vertices: ${connected.reduce((sum, part) => sum + part.length, 0)}`);
  connected.forEach((part) => addLine(part, RESULT_COLORS[1], 4.0));

  const split = normalizeParts(viewer.arcSplitOnCross(SPLIT_ARC, [SPLIT_CUTTER]));
  details.push(`ArcSplitOnCross result parts: ${split.length}`);
  split.forEach((part, index) => addLine(part, RESULT_COLORS[(index + 2) % RESULT_COLORS.length], 4.0));
}

function renderScene(showResults) {
  const currentExtent = showResults ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  addSources();
  const details = [
    "ArcFind / ArcMakeConnected / ArcSplitOnCross", "", "1. ArcFind",
    `Query arc extent: ${extentText(FIND_QUERY)}`, `Candidate count: ${FIND_CANDIDATES.length}`, "",
    "2. ArcMakeConnected", `Base vertices: ${CONNECT_BASE.length}`,
    `Continuation vertices: ${CONNECT_CONTINUATION.length}`, "", "3. ArcSplitOnCross",
    `Split arc vertices: ${SPLIT_ARC.length}`, `Cutter vertices: ${SPLIT_CUTTER.length}`,
  ];
  if (!showResults) {
    details.push("", "Result: click Run Arc Operations to calculate");
    viewer.setStatusText("Source arcs are ready. Click Run Arc Operations.");
  } else {
    addResults(details);
    viewer.setStatusText("Arc operations calculated.");
  }
  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(currentExtent ?? FULL_EXTENT);
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
  viewer = new ViewerWindow({ title: "ArcOperations", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run Arc Operations" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`ArcOperations failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("ArcOperations details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  renderScene(false);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
