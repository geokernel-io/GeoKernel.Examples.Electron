"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const POINT_WKT = "POINT(-122.4194 37.7749)";
const LINE_WKT =
  "LINESTRING(-123.0 37.1, -122.5 37.8, -121.9 37.3, -121.2 38.0)";
const POLYGON_WKT =
  "POLYGON((-123.25 37.15, -122.15 36.95, -121.55 37.65, -122.05 38.35, -123.05 38.15, -123.25 37.15))";
const VIEW_EXTENT = extent(-124.0, 36.4, -120.3, 38.7);
const POINT_STYLE = Object.freeze({
  pointColor: "#D95D39",
  lineColor: "#8C321D",
  pointSize: 12.0,
});
const LINE_STYLE = Object.freeze({
  lineColor: "#E4572E",
  lineWidth: 3.0,
});
const POLYGON_STYLE = Object.freeze({
  fillColor: "#88D18A",
  fillOpacity: 128,
  lineColor: "#1F7A4D",
  lineWidth: 2.2,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll")
      : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);

  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(
      `GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`,
    );
  }
}

function runSample() {
  const point = viewer.readWktPoint(POINT_WKT);
  const line = viewer.readWktLineString(LINE_WKT)
    .map((item) => ({ x: Number(item.x), y: Number(item.y) }));
  const polygon = viewer.readWktPolygon(POLYGON_WKT, false)
    .map((ring) => ring.map((item) => ({
      x: Number(item.x),
      y: Number(item.y),
    })));

  viewer.addPolygonLayer("WKT Polygons", polygon, POLYGON_STYLE);
  viewer.addPolylineLayer("WKT Lines", [line], LINE_STYLE);
  viewer.addPointLayer("WKT Points", [point], POINT_STYLE);

  viewer.clearLog();
  viewer.appendLog([
    "WktOverlay sample",
    "",
    "API",
    "GisWktReader::readPoint/readLineString/readPolygon",
    "GisViewer::addLayer(layer)",
    "",
    "Three WKT strings are parsed and displayed as overlay layers.",
  ].join("\n"));
  viewer.setStatusText("WktOverlay ready.");
  viewer.setViewExtent(VIEW_EXTENT);
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
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

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
}

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "WktOverlay",
    width: 1100,
    height: 720,
    navigationToolbar: false,
  });
  viewer.addLogPanel("WKT overlay details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  runSample();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) {
    try {
      viewer.close();
    } catch {
      // Native window may already be gone.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
