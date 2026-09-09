"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const LEFT = [
  [-4.5, -1.6], [-3.1, 1.8], [-1.9, -0.5], [-0.5, 1.4],
  [-0.1, -1.8], [-2.1, -0.9], [-3.5, -2.0], [-4.5, -1.6],
];
const RIGHT = [
  [0.9, -1.4], [2.3, -2.0], [4.2, -0.2], [3.4, 2.3],
  [1.6, 1.3], [0.4, 2.7], [0.9, -1.4],
];
const FULL_EXTENT = extent(-5.4, -3.1, 5.3, 3.5);
const LEFT_STYLE = { fillColor: "#BFD7EA", fillOpacity: 110, lineColor: "#2F80C2", lineWidth: 2.2 };
const RIGHT_STYLE = { fillColor: "#CDE7D8", fillOpacity: 110, lineColor: "#2D6A4F", lineWidth: 2.2 };
const HULL_STYLE = { fillColor: "#F9C74F", fillOpacity: 105, lineColor: "#D95D39", lineWidth: 3.0 };

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

function polygonExtent(points) {
  const xs = points.map((point) => Number(point.x ?? point[0]));
  const ys = points.map((point) => Number(point.y ?? point[1]));
  return extent(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function extentText(value) {
  return `(${value.xMin.toFixed(2)}, ${value.yMin.toFixed(2)}) - (${value.xMax.toFixed(2)}, ${value.yMax.toFixed(2)})`;
}

function normalizeParts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => Array.isArray(part)
    ? part.map((point) => [Number(point.x ?? point[0]), Number(point.y ?? point[1])])
    : []).filter((part) => part.length > 0);
}

function renderScene(showHull) {
  const currentExtent = showHull ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  if (!viewer.addPolygonShape(LEFT, LEFT_STYLE) || !viewer.addPolygonShape(RIGHT, RIGHT_STYLE)) {
    throw new Error("Source polygon shapes could not be rendered.");
  }
  const details = [
    "ConvexHull(left, right)",
    "Source geometry count: 2",
    `Left vertices: ${LEFT.length}`,
    `Right vertices: ${RIGHT.length}`,
    `Left extent: ${extentText(polygonExtent(LEFT))}`,
    `Right extent: ${extentText(polygonExtent(RIGHT))}`,
  ];
  if (!showHull) {
    details.push("Result: click Run Convex Hull to calculate");
    viewer.setStatusText("Two source geometries are ready. Click Run Convex Hull.");
  } else {
    const parts = normalizeParts(viewer.convexHullTwoPolygons(LEFT, RIGHT));
    if (parts.length === 0) {
      details.push("Result: empty");
      viewer.setStatusText("Convex hull returned an empty result.");
    } else {
      if (!viewer.addPolygonPartsShape(parts, HULL_STYLE)) throw new Error("Convex hull result could not be rendered.");
      details.push(
        `Hull parts: ${parts.length}`,
        `Hull vertices: ${parts[0].length}`,
        `Hull extent: ${extentText(polygonExtent(parts.flat()))}`,
      );
      viewer.setStatusText("Convex hull result created.");
    }
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
  viewer = new ViewerWindow({ title: "ConvexHull Two", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run Convex Hull" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`ConvexHullTwo failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("ConvexHullTwo details");
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
