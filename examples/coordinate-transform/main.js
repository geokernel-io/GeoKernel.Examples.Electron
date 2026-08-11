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
const WORLD_EXTENT = extent(-180, -85, 180, 85);
const COMMAND = Object.freeze({ FULL_EXTENT: 1 });
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

function showWorldExtent() {
  viewer.setViewExtent(WORLD_EXTENT);
  viewer.setStatusText(
    "Move the mouse over the map to transform EPSG:4326 longitude/latitude to EPSG:3857 Web Mercator meters."
  );
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer || commandId !== COMMAND.FULL_EXTENT) return;
    try { showWorldExtent(); }
    catch (error) {
      viewer?.setStatusText(`Full extent failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function showTransformedCoordinate(event) {
  const longitude = Number(event.extent.xMin);
  const latitude = Number(event.extent.yMin);
  if (!Number.isFinite(longitude)
      || !Number.isFinite(latitude)
      || longitude < -180
      || longitude > 180
      || latitude <= -90
      || latitude >= 90) {
    viewer.setStatusText("Move mouse over the map.");
    return;
  }

  const transformed = viewer.transformPoint(4326, 3857, longitude, latitude);
  if (!transformed) {
    viewer.setStatusText("Coordinate is outside the transformable range.");
    return;
  }
  viewer.setStatusText(
    `EPSG:4326 lon/lat: ${longitude.toFixed(6)}, ${latitude.toFixed(6)}`
    + `    ->    EPSG:3857 meters: ${Number(transformed.x).toFixed(2)}, ${Number(transformed.y).toFixed(2)}`
  );
}

function onViewerEvent(event) {
  if (event.eventType !== ViewerEventType.MOUSE_COORDINATES_CHANGED) return;
  try { showTransformedCoordinate(event); }
  catch (error) {
    viewer?.setStatusText(`Coordinate transform failed: ${error.message}`);
    console.error(error?.stack || error);
  }
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
    title: "CoordinateTransform",
    width: 1200,
    height: 800,
    navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing EPSG:4326 world layer...");
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
  viewer.setLayerName(0, "World countries");
  if (!viewer.setLayerCoordinateSystemPreset(0, "EPSG:4326")) {
    throw new Error("World layer coordinate system could not be set to EPSG:4326.");
  }
  if (!viewer.setCoordinateSystemPreset("EPSG:4326")) {
    throw new Error("Viewer coordinate system could not be set to EPSG:4326.");
  }
  const transformCheck = viewer.transformPoint(4326, 3857, 0, 0);
  if (!transformCheck
      || !Number.isFinite(transformCheck.x)
      || !Number.isFinite(transformCheck.y)) {
    throw new Error("EPSG:4326 to EPSG:3857 coordinate transform is unavailable.");
  }
  viewer.setLayerStyle(0, WORLD_STYLE);
  viewer.refreshLayers();
  viewer.processEvents();
  showWorldExtent();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
