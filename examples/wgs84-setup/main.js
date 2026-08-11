"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const WORLD_LAYER_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const WGS84_WORLD_EXTENT = extent(-180, -85, 180, 85);
const WORLD_STYLE = Object.freeze({
  fillColor: "#D8E5E1",
  fillOpacity: 210,
  lineColor: "#6F8883",
  lineWidth: 0.75,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let worldLayerLoaded = false;

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
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function showWgs84Extent() {
  if (!viewer || !worldLayerLoaded) return;
  viewer.setViewExtent(WGS84_WORLD_EXTENT);
  viewer.setStatusText("Move the mouse over the map to inspect EPSG:4326 longitude and latitude.");
}

function onViewerEvent(event) {
  if (!viewer || event.eventType !== ViewerEventType.MOUSE_COORDINATES_CHANGED) return;

  const screenX = Number(event.screenRectangle?.left);
  const screenY = Number(event.screenRectangle?.top);
  const longitude = Number(event.extent?.xMin);
  const latitude = Number(event.extent?.yMin);
  if (![screenX, screenY, longitude, latitude].every(Number.isFinite)) return;

  viewer.setStatusText(
    `Screen: ${screenX.toFixed(0)}, ${screenY.toFixed(0)}`
    + `    |    EPSG:4326 lon/lat: ${longitude.toFixed(6)}, ${latitude.toFixed(6)}`,
  );
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
      if (Date.now() - viewerHiddenSince > 750) app.quit();
    }
  }, 16);
}

async function start() {
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "Wgs84Setup",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing EPSG:4326 world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(
    WORLD_LAYER_URL,
    "world_4326.zip",
    "world_4326",
    "world_4326.shp",
  );
  if (!viewer) return;

  viewer.addLayer(worldPath);
  viewer.setLayerName(0, "World countries - EPSG:4326");
  if (!viewer.setLayerCoordinateSystemPreset(0, "EPSG:4326")) {
    throw new Error("World layer coordinate system could not be set to EPSG:4326.");
  }
  viewer.setLayerStyle(0, WORLD_STYLE);

  if (!viewer.setCoordinateSystemPreset("EPSG:4326")) {
    throw new Error("Viewer coordinate system could not be set to EPSG:4326.");
  }
  worldLayerLoaded = true;
  viewer.refreshLayers();
  showWgs84Extent();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  worldLayerLoaded = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
