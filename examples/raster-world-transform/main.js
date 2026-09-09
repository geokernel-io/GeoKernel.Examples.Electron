"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_8km_tif.zip";
const RASTER_LAYER_NAME = "World Raster";
const MARKER_LAYER_NAME = "Pixel Marker";

const CONTROL = Object.freeze({
  PIXEL_X: 1,
  PIXEL_Y: 2,
  PICK_WORLD_POINT: 3,
  FULL_EXTENT: 4,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let rasterLayerIndex = -1;
let pixelX = 0;
let pixelY = 0;
let updatingControls = false;
let controlsReady = false;

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

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || 0)));
}

function transformText(result) {
  return [
    "RasterWorldTransform sample",
    "",
    `Path: ${result.path || "unknown"}`,
    `Raster size: ${result.width} x ${result.height}`,
    `EPSG: ${result.epsgCode || "unknown"}`,
    "",
    "GisRasterWorldTransform",
    `upperLeftCenterX: ${Number(result.upperLeftCenterX).toFixed(6)}`,
    `upperLeftCenterY: ${Number(result.upperLeftCenterY).toFixed(6)}`,
    `pixelSizeX: ${Number(result.pixelSizeX).toFixed(9)}`,
    `pixelSizeY: ${Number(result.pixelSizeY).toFixed(9)}`,
    `rotationX: ${Number(result.rotationX).toFixed(9)}`,
    `rotationY: ${Number(result.rotationY).toFixed(9)}`,
    "",
    `Pixel: ${Number(result.pixelX).toFixed(3)}, ${Number(result.pixelY).toFixed(3)}`,
    `World: ${Number(result.worldX).toFixed(6)}, ${Number(result.worldY).toFixed(6)}`,
    `Reverse pixel: ${Number(result.reversePixelX).toFixed(3)}, ${Number(result.reversePixelY).toFixed(3)}`,
    "",
    "Transform equations",
    "worldX = upperLeftCenterX + pixelX * pixelSizeX + pixelY * rotationY",
    "worldY = upperLeftCenterY + pixelX * rotationX + pixelY * pixelSizeY",
  ].join("\n");
}

function replacePixelMarker(worldX, worldY) {
  viewer.removeLayerByName(MARKER_LAYER_NAME);
  viewer.addPointLayer(MARKER_LAYER_NAME, [[Number(worldX), Number(worldY)]]);
  const markerIndex = Number(viewer.layerInfoByName(MARKER_LAYER_NAME)?.index ?? -1);
  if (markerIndex >= 0) {
    viewer.setLayerStyle(markerIndex, {
      pointColor: "#F05A36",
      pointOutlineColor: "#8F2D15",
      pointSize: 12,
      lineWidth: 2,
    });
  }
}

function currentRasterLayerIndex() {
  const index = Number(viewer?.layerInfoByName(RASTER_LAYER_NAME)?.index ?? -1);
  if (index >= 0) rasterLayerIndex = index;
  return index;
}

function showPixel() {
  const index = currentRasterLayerIndex();
  if (!viewer || index < 0) return;
  const result = viewer.rasterWorldTransform(index, pixelX, pixelY);
  if (!result || !Number.isFinite(Number(result.worldX)) || !Number.isFinite(Number(result.worldY))) {
    throw new Error("Raster world transform could not be read.");
  }
  replacePixelMarker(result.worldX, result.worldY);
  viewer.clearLog();
  viewer.appendLog(transformText(result));
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.setStatusText(`Pixel (${pixelX}, ${pixelY}) -> world (${Number(result.worldX).toFixed(3)}, ${Number(result.worldY).toFixed(3)})`);
}

function selectWorldPoint(worldX, worldY) {
  const index = currentRasterLayerIndex();
  if (index < 0) return;
  const transform = viewer.rasterWorldTransform(index, 0, 0);
  const dx = Number(worldX) - Number(transform.upperLeftCenterX);
  const dy = Number(worldY) - Number(transform.upperLeftCenterY);
  const pixelSizeX = Number(transform.pixelSizeX);
  const pixelSizeY = Number(transform.pixelSizeY);
  const rotationX = Number(transform.rotationX);
  const rotationY = Number(transform.rotationY);
  const determinant = pixelSizeX * pixelSizeY - rotationX * rotationY;
  if (Math.abs(determinant) < 1e-12) return;

  pixelX = clamp((dx * pixelSizeY - rotationY * dy) / determinant, 0, Number(transform.width) - 1);
  pixelY = clamp((pixelSizeX * dy - dx * rotationX) / determinant, 0, Number(transform.height) - 1);
  updatingControls = true;
  viewer.setControlValue(CONTROL.PIXEL_X, pixelX);
  viewer.setControlValue(CONTROL.PIXEL_Y, pixelY);
  updatingControls = false;
  showPixel();
}

function onControlChanged(controlId, numericValue) {
  if (!viewer || updatingControls || !controlsReady) return;
  if (controlId === CONTROL.PIXEL_X) {
    pixelX = Math.round(numericValue);
    showPixel();
  } else if (controlId === CONTROL.PIXEL_Y) {
    pixelY = Math.round(numericValue);
    showPixel();
  } else if (controlId === CONTROL.PICK_WORLD_POINT) {
    viewer.setTool(ViewerTool.INFO);
    viewer.setStatusText("Click the raster to convert a world coordinate to a pixel coordinate.");
  } else if (controlId === CONTROL.FULL_EXTENT) {
    viewer.zoomToLayer(rasterLayerIndex);
  }
}

function onViewerEvent(event) {
  if (!viewer || rasterLayerIndex < 0) return;
  if (event.eventType === ViewerEventType.MAP_MOUSE_UP && event.intValue === ViewerTool.INFO) {
    selectWorldPoint(event.extent?.xMin, event.extent?.yMin);
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
    title: "RasterWorldTransform",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addLogPanel("Raster world transform");
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing raster sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const tiffPath = await ensureSampleFile(
    SAMPLE_URL,
    "world_8km_tif.zip",
    "world_8km_tif",
    "world_8km.tif",
  );
  if (!viewer || closing) return;

  viewer.addLayer(tiffPath);
  rasterLayerIndex = viewer.layerCount() - 1;
  if (rasterLayerIndex < 0) throw new Error(`GeoTIFF could not be loaded: ${tiffPath}`);
  viewer.setLayerName(rasterLayerIndex, RASTER_LAYER_NAME);

  const transform = viewer.rasterWorldTransform(rasterLayerIndex, 0, 0);
  pixelX = Math.floor(Number(transform.width) / 2);
  pixelY = Math.floor(Number(transform.height) / 2);
  viewer.addControlPanel({
    title: "Pixel coordinate",
    width: 280,
    controls: [
      { id: CONTROL.PIXEL_X, type: "number", label: "Pixel X", value: pixelX, minimum: 0, maximum: Number(transform.width) - 1, step: 1, decimals: 0 },
      { id: CONTROL.PIXEL_Y, type: "number", label: "Pixel Y", value: pixelY, minimum: 0, maximum: Number(transform.height) - 1, step: 1, decimals: 0 },
      { id: CONTROL.PICK_WORLD_POINT, type: "button", text: "Pick World Point" },
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
    ],
  }, onControlChanged);
  controlsReady = true;
  viewer.zoomToLayer(rasterLayerIndex);
  showPixel();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  rasterLayerIndex = -1;
  controlsReady = false;
  if (viewer) {
    try {
      viewer.close();
    } catch {
      // The native window may already have been destroyed.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
