"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerEventType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const LAYER_NAME = "Drawn Polygons";
const COMMAND = Object.freeze({ FULL_EXTENT: 1, ADD_POLYGON: 2, PAN: 3, CLEAR: 4 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POLYGON_STYLE = Object.freeze({ fillColor: "#F2D27A", fillOpacity: 160, lineColor: "#D95D39", lineWidth: 2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let polygonLayerIndex = -1;
let addPolygonMode = true;

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

function polygonCount() {
  return polygonLayerIndex >= 0 ? viewer.layerFeatureCount(polygonLayerIndex) : 0;
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Polygon count: ${polygonCount()}`);
}

function activatePolygonEditing() {
  if (polygonLayerIndex < 0) throw new Error(`${LAYER_NAME} layer is not in the viewer.`);
  if (!viewer.isLayerEditing(polygonLayerIndex) && !viewer.beginEditLayer(polygonLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(polygonLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not be activated for editing.`);
  }
}

function activateAddPolygon() {
  activatePolygonEditing();
  addPolygonMode = true;
  viewer.setTool(ViewerTool.ADD_POLYGON);
  updateStatus("Add Polygon active. Click vertices, then press Enter or double-click to finish.");
}

function activatePan() {
  addPolygonMode = false;
  viewer.setTool(ViewerTool.PAN);
  updateStatus("Pan tool active.");
}

function clearPolygons() {
  if (!viewer.rollbackEditLayer(polygonLayerIndex)) throw new Error("The polygons could not be cleared.");
  activatePolygonEditing();
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  if (addPolygonMode) viewer.setTool(ViewerTool.ADD_POLYGON);
  updateStatus("Drawn polygons cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateStatus("Sample extent restored.");
  } else if (commandId === COMMAND.ADD_POLYGON) {
    activateAddPolygon();
  } else if (commandId === COMMAND.PAN) {
    activatePan();
  } else if (commandId === COMMAND.CLEAR) {
    clearPolygons();
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
    if (!viewer || polygonLayerIndex < 0) return;
    updateStatus(addPolygonMode
      ? "Polygon layer updated. Click vertices, then press Enter or double-click to finish."
      : "Polygon layer updated.");
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
  viewer = new ViewerWindow({ title: "AddPolygonInteractive", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
    { id: COMMAND.ADD_POLYGON, text: "Add Polygon", separatorBefore: true },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.CLEAR, text: "Clear Polygons", separatorBefore: true },
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
    polygonLayerIndex = viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POLYGON, POLYGON_STYLE);
    if (polygonLayerIndex < 0) throw new Error("The editable polygon layer could not be created.");
    activatePolygonEditing();
    viewer.setEventCallback(onViewerEvent);
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    activateAddPolygon();
  } catch (error) {
    viewer?.setStatusText("Editable polygon layer could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polygonLayerIndex = -1;
  addPolygonMode = true;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
