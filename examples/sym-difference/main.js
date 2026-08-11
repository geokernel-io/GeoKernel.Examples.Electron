"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const LEFT = [[-4.4, -1.8], [1.2, -1.8], [1.2, 2.2], [-4.4, 2.2], [-4.4, -1.8]];
const RIGHT = [
  [-0.2, 3.0], [0.6, 1.2], [3.2, 1.2], [1.1, -0.1], [2.0, -2.0],
  [-0.2, -0.8], [-2.4, -2.0], [-1.5, -0.1], [-3.6, 1.2], [-1.0, 1.2], [-0.2, 3.0],
];
const FULL_EXTENT = extent(-5.2, -3.2, 5.0, 4.0);
const LEFT_STYLE = { fillColor: "#BFD7EA", fillOpacity: 115, lineColor: "#2F80C2", lineWidth: 2.0 };
const RIGHT_STYLE = { fillColor: "#CDE7D8", fillOpacity: 115, lineColor: "#2D6A4F", lineWidth: 2.0 };
const RESULT_STYLE = { fillColor: "#F9C74F", fillOpacity: 155, lineColor: "#D95D39", lineWidth: 3.0 };

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

function renderScene(showResult) {
  const currentExtent = showResult ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  if (!viewer.addPolygonShape(LEFT, LEFT_STYLE) || !viewer.addPolygonShape(RIGHT, RIGHT_STYLE)) {
    throw new Error("Source polygon shapes could not be rendered.");
  }
  const details = [
    "SymmetricalDifference(left, right)",
    "This keeps areas that belong to only one source polygon.",
    `Left extent: ${extentText(polygonExtent(LEFT))}`,
    `Right extent: ${extentText(polygonExtent(RIGHT))}`,
  ];
  if (!showResult) {
    details.push("Result: click Run Sym Difference to calculate");
    viewer.setStatusText("Source polygons are ready. Click Run Sym Difference.");
  } else {
    const parts = normalizeParts(viewer.symmetricalDifferencePolygons(LEFT, RIGHT));
    if (parts.length === 0) {
      details.push("Result: empty");
      viewer.setStatusText("Symmetrical difference returned an empty result.");
    } else {
      if (!viewer.addPolygonPartsShape(parts, RESULT_STYLE)) {
        throw new Error("Symmetrical difference result could not be rendered.");
      }
      details.push(
        "Result type: polygon",
        `Result parts: ${parts.length}`,
        `Result extent: ${extentText(polygonExtent(parts.flat()))}`,
      );
      viewer.setStatusText("Symmetrical difference result created.");
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
  viewer = new ViewerWindow({ title: "SymDifference", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run Sym Difference" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`SymDifference failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("SymDifference details");
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
