"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const POLYGON = [
  [-4.4, -2.0], [3.8, -2.0], [3.8, 2.0], [1.0, 2.0], [1.0, -0.4],
  [-1.1, -0.4], [-1.1, 2.0], [-4.4, 2.0], [-4.4, -2.0],
];
const FULL_EXTENT = extent(-5.4, -3.0, 4.8, 3.0);
const POLYGON_STYLE = { fillColor: "#BFD7EA", fillOpacity: 110, lineColor: "#1F6F8B", lineWidth: 2.2 };
const CENTROID_STYLE = { pointColor: "#D95D39", pointSize: 12, lineColor: "#8F2D1B", lineWidth: 1.4 };
const LABEL_POINT_STYLE = { pointColor: "#2A9D8F", pointSize: 12, lineColor: "#145A4B", lineWidth: 1.4 };

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

function pointText(point) {
  return `(${Number(point.x).toFixed(3)}, ${Number(point.y).toFixed(3)})`;
}

function renderScene() {
  const info = viewer.polygonCentroidInfo(POLYGON);
  if (!info.centroid || !info.labelPoint) {
    throw new Error("Polygon centroid information could not be calculated.");
  }

  viewer.clearShapes();
  if (!viewer.addPolygonShape(POLYGON, POLYGON_STYLE)) throw new Error("Source polygon could not be rendered.");
  if (!viewer.addPointShape(info.centroid.x, info.centroid.y, CENTROID_STYLE)) throw new Error("Centroid could not be rendered.");
  if (!viewer.addPointShape(info.labelPoint.x, info.labelPoint.y, LABEL_POINT_STYLE)) throw new Error("Label point could not be rendered.");

  viewer.clearLog();
  viewer.appendLog([
    "GisShapePolygon::centroid() / labelPoint()",
    "",
    `Centroid: ${pointText(info.centroid)}`,
    `Centroid inside polygon: ${Boolean(info.centroidInside)}`,
    "",
    `Label point: ${pointText(info.labelPoint)}`,
    `Label point inside polygon: ${Boolean(info.labelPointInside)}`,
    "",
    "Visual guide:",
    "Blue polygon: source concave polygon",
    "Orange point: centroid()",
    "Green point: labelPoint()",
    "",
    "For concave polygons, centroid() may fall outside the polygon while labelPoint() remains suitable for labels.",
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(FULL_EXTENT);
  viewer.setStatusText("Centroid and label point rendered.");
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
    if (viewer.isVisible()) {
      viewerWasVisible = true;
      viewerHiddenSince = 0;
    } else if (viewerWasVisible) {
      if (viewerHiddenSince === 0) viewerHiddenSince = Date.now();
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "ShapeCentroid", width: 1040, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([{ id: 1, text: "Full Extent" }], (id) => {
    if (id === 1) viewer.setViewExtent(FULL_EXTENT);
  });
  viewer.addLogPanel("Centroid details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  renderScene();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (viewer) {
    try { viewer.close(); } catch { /* Native window may already be gone. */ }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
