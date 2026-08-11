"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const POLYGON = [
  [-4.0, -2.0], [3.8, -2.0], [4.5, 0.5], [2.5, 2.4],
  [-1.5, 2.1], [-4.4, 0.6], [-4.0, -2.0],
];
const ARC = [[-5.2, 1.4], [-1.8, 0.7], [0.2, -0.2], [2.0, -0.6], [5.1, -1.0]];
const RESULT_COLORS = ["#F9C74F", "#A7D8F0", "#CDE7D8"];
const FULL_EXTENT = extent(-5.7, -3.0, 5.7, 3.2);
const POLYGON_STYLE = { fillColor: "#BFD7EA", fillOpacity: 115, lineColor: "#2F80C2", lineWidth: 2.2 };
const ARC_STYLE = { lineColor: "#2D3436", lineWidth: 2.8 };

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

function shapeExtent(points) {
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

function addSources() {
  if (!viewer.addPolygonShape(POLYGON, POLYGON_STYLE) || !viewer.addPolylineShape(ARC, ARC_STYLE)) {
    throw new Error("Source shapes could not be rendered.");
  }
}

function renderScene(showResult) {
  const currentExtent = showResult ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  addSources();
  const details = [
    "SplitByArc(polygon, line)",
    "Source polygon parts: 1",
    "Split arc parts: 1",
    `Polygon extent: ${extentText(shapeExtent(POLYGON))}`,
    `Arc extent: ${extentText(shapeExtent(ARC))}`,
  ];
  if (!showResult) {
    details.push("Result: click Run SplitByArc to calculate");
    viewer.setStatusText("Source polygon and split arc are ready. Click Run SplitByArc.");
  } else {
    const pieces = normalizeParts(viewer.splitPolygonByArc(POLYGON, ARC));
    details.push(`Result shapes: ${pieces.length}`);
    pieces.forEach((piece, index) => {
      const style = {
        fillColor: RESULT_COLORS[index % RESULT_COLORS.length],
        fillOpacity: 155,
        lineColor: "#D95D39",
        lineWidth: 2.8,
      };
      if (!viewer.addPolygonShape(piece, style)) throw new Error(`Result piece ${index + 1} could not be rendered.`);
      details.push(`Piece ${index + 1} parts: 1 extent: ${extentText(shapeExtent(piece))}`);
    });
    if (pieces.length > 0) {
      viewer.addPolylineShape(ARC, ARC_STYLE);
      viewer.setStatusText("SplitByArc result created.");
    } else viewer.setStatusText("SplitByArc returned an empty result.");
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
  viewer = new ViewerWindow({ title: "SplitByArc", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run SplitByArc" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`SplitByArc failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("SplitByArc details");
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
