"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const LAYER_NAME = "Programmatic Polylines";
const COMMAND = Object.freeze({ ADD_POLYLINE: 1, CLEAR: 2, FULL_EXTENT: 3 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POLYLINE_STYLE = Object.freeze({ lineColor: "#D95D39", lineWidth: 2.6 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let polylineLayerIndex = -1;
let polylineCursor = 0;

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

function polylineCount() {
  return polylineLayerIndex >= 0 ? viewer.layerFeatureCount(polylineLayerIndex) : 0;
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Polyline count: ${polylineCount()}`);
}

function activatePolylineEditing() {
  if (polylineLayerIndex < 0) throw new Error(`${LAYER_NAME} layer is not in the viewer.`);
  if (!viewer.isLayerEditing(polylineLayerIndex) && !viewer.beginEditLayer(polylineLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(polylineLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not be activated for editing.`);
  }
}

function samplePolylineAt(index) {
  const column = index % 7;
  const row = Math.floor(index / 7);
  const x = -124 + column * 7;
  const y = 29 + row * 3;
  return [[x, y], [x + 2.2, y + 1.4], [x + 4.8, y + 0.4], [x + 6.4, y + 2.2]];
}

function addNextPolyline() {
  activatePolylineEditing();
  const points = samplePolylineAt(polylineCursor);
  if (!viewer.addPolylineToEditLayer(polylineLayerIndex, points)) throw new Error("Polyline could not be added.");
  polylineCursor += 1;
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateStatus(`addPolylineToEditLayer(${polylineLayerIndex}, ${points.length} vertices)`);
}

function clearPolylines() {
  if (!viewer.rollbackEditLayer(polylineLayerIndex)) throw new Error("The polylines could not be cleared.");
  activatePolylineEditing();
  polylineCursor = 0;
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateStatus("Programmatic polylines cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POLYLINE) {
    addNextPolyline();
  } else if (commandId === COMMAND.CLEAR) {
    clearPolylines();
  } else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateStatus("Sample extent restored.");
  }
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleCommand(commandId);
    } catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
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
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "AddPolylineProgrammatic", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POLYLINE, text: "Add Polyline" },
    { id: COMMAND.CLEAR, text: "Clear Lines" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
    if (!viewer) return;
    viewer.addLayer(worldPath, { buildFeatureSource: true });
    viewer.setLayerName(0, "World");
    viewer.setLayerStyle(0, WORLD_STYLE);
    polylineLayerIndex = viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POLYLINE, POLYLINE_STYLE);
    if (polylineLayerIndex < 0) throw new Error("The programmatic polyline layer could not be created.");
    activatePolylineEditing();
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    updateStatus("Click Add Polyline to call addPolylineToEditLayer(index, worldPoints).");
  } catch (error) {
    viewer?.setStatusText("Programmatic polyline layer could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polylineLayerIndex = -1;
  polylineCursor = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
