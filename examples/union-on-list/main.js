"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const POLYGONS = [
  [[-4.8, -1.4], [-0.8, -1.4], [-0.8, 1.8], [-4.8, 1.8], [-4.8, -1.4]],
  [[-2.6, -2.3], [1.2, -2.3], [1.2, 0.6], [-2.6, 0.6], [-2.6, -2.3]],
  [[0.3, 2.8], [0.9, 1.1], [2.8, 1.1], [1.3, 0.1], [2.1, -1.6], [0.3, -0.6],
    [-1.5, -1.6], [-0.7, 0.1], [-2.2, 1.1], [-0.3, 1.1], [0.3, 2.8]],
  [[1.5, -0.2], [4.6, -0.2], [4.6, 2.0], [1.5, 2.0], [1.5, -0.2]],
  [[2.0, -2.4], [4.8, -1.2], [3.3, 0.7], [2.0, -2.4]],
];
const SOURCE_STYLES = [
  ["#BFD7EA", "#2F80C2"], ["#D8EAC4", "#5B8E3E"], ["#F3D6A3", "#B7791F"],
  ["#D9C8F0", "#7048A8"], ["#BFE3D9", "#2D6A4F"],
];
const RESULT_STYLE = { fillColor: "#F9C74F", fillOpacity: 135, lineColor: "#D95D39", lineWidth: 3.0 };
const FULL_EXTENT = extent(-5.8, -3.3, 5.8, 4.0);

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

function addSources() {
  POLYGONS.forEach((polygon, index) => {
    const [fillColor, lineColor] = SOURCE_STYLES[index];
    if (!viewer.addPolygonShape(polygon, { fillColor, fillOpacity: 110, lineColor, lineWidth: 2.0 })) {
      throw new Error("Source polygon shape could not be rendered.");
    }
  });
}

function renderScene(showResult) {
  viewer.clearShapes();
  addSources();
  const details = ["UnionOnList(shapes)", `Source polygons: ${POLYGONS.length}`];
  POLYGONS.forEach((polygon, index) => details.push(`Source ${index + 1} extent: ${extentText(polygonExtent(polygon))}`));

  if (!showResult) {
    details.push("Result: click Run UnionOnList to calculate");
    viewer.setStatusText("Source polygons are ready. Click Run UnionOnList.");
  } else {
    const parts = normalizeParts(viewer.unionPolygonsOnList(POLYGONS));
    if (parts.length === 0) {
      details.push("Result: empty");
      viewer.setStatusText("UnionOnList returned an empty result.");
    } else {
      for (const part of parts) {
        if (!viewer.addPolygonShape(part, RESULT_STYLE)) throw new Error("UnionOnList result shape could not be rendered.");
      }
      details.push(
        "Result type: polygon",
        `Result parts: ${parts.length}`,
        `Result extent: ${extentText(polygonExtent(parts.flat()))}`,
      );
      viewer.setStatusText("UnionOnList result created.");
    }
  }
  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(FULL_EXTENT);
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
  viewer = new ViewerWindow({ title: "UnionOnList", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run UnionOnList" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`UnionOnList failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("UnionOnList details");
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
