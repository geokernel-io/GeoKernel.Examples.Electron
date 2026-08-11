"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerEventType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const LAYER_NAME = "Drawn Polylines";
const COMMAND = Object.freeze({ FULL_EXTENT: 1, ADD_POLYLINE: 2, PAN: 3, CLEAR: 4 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POLYLINE_STYLE = Object.freeze({ lineColor: "#D95D39", lineWidth: 2.6 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let polylineLayerIndex = -1;
let addPolylineMode = true;

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

function activateAddPolyline() {
  activatePolylineEditing();
  addPolylineMode = true;
  viewer.setTool(ViewerTool.ADD_POLYLINE);
  updateStatus("Add Polyline active. Click vertices, then press Enter or double-click to finish.");
}

function activatePan() {
  addPolylineMode = false;
  viewer.setTool(ViewerTool.PAN);
  updateStatus("Pan tool active.");
}

function clearPolylines() {
  if (!viewer.rollbackEditLayer(polylineLayerIndex)) throw new Error("The polylines could not be cleared.");
  activatePolylineEditing();
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  if (addPolylineMode) viewer.setTool(ViewerTool.ADD_POLYLINE);
  updateStatus("Drawn polylines cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateStatus("Sample extent restored.");
  } else if (commandId === COMMAND.ADD_POLYLINE) {
    activateAddPolyline();
  } else if (commandId === COMMAND.PAN) {
    activatePan();
  } else if (commandId === COMMAND.CLEAR) {
    clearPolylines();
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

function onViewerEvent(event) {
  if (event.eventType !== ViewerEventType.LAYER_EDIT_STATE_CHANGED) return;
  setImmediate(() => {
    if (!viewer || polylineLayerIndex < 0) return;
    updateStatus(addPolylineMode
      ? "Polyline layer updated. Click vertices, then press Enter or double-click to finish."
      : "Polyline layer updated.");
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
  viewer = new ViewerWindow({ title: "AddPolylineInteractive", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
    { id: COMMAND.ADD_POLYLINE, text: "Add Polyline", separatorBefore: true },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.CLEAR, text: "Clear Lines", separatorBefore: true },
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
    if (polylineLayerIndex < 0) throw new Error("The editable polyline layer could not be created.");
    activatePolylineEditing();
    viewer.setEventCallback(onViewerEvent);
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    activateAddPolyline();
  } catch (error) {
    viewer?.setStatusText("Editable polyline layer could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polylineLayerIndex = -1;
  addPolylineMode = true;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
