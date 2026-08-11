"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const SOURCE = [
  [-4.4, -1.6], [-3.4, 1.6], [-1.9, -0.7], [-0.4, 2.3], [0.8, -1.2], [2.0, 1.7],
  [3.9, -0.5], [2.5, -2.1], [0.4, -0.2], [-1.2, -2.0], [-2.7, 0.0], [-4.4, -1.6],
];
const FULL_EXTENT = extent(-5.3, -3.1, 5.2, 3.4);
const SOURCE_STYLE = { fillColor: "#BFD7EA", fillOpacity: 100, lineColor: "#1F6F9F", lineWidth: 2.4 };
const HULL_STYLE = { fillColor: "#F9C74F", fillOpacity: 115, lineColor: "#D95D39", lineWidth: 3.0 };

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
  if (!viewer.addPolygonShape(SOURCE, SOURCE_STYLE)) throw new Error("Source polygon shape could not be rendered.");

  const details = [
    "ConvexHull(shape)",
    "Source type: polygon",
    "Source geometry count: 1",
    `Source vertices: ${SOURCE.length}`,
    `Source extent: ${extentText(polygonExtent(SOURCE))}`,
  ];
  if (!showHull) {
    details.push("Result: click Run Convex Hull to calculate");
    viewer.setStatusText("Source geometry is ready. Click Run Convex Hull.");
  } else {
    const parts = normalizeParts(viewer.convexHullPolygon(SOURCE));
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
  viewer = new ViewerWindow({ title: "ConvexHull Shape", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run Convex Hull" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`ConvexHull failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("ConvexHull details");
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
