"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const LAYER_NAME = "Programmatic Polygons";
const COMMAND = Object.freeze({ ADD_POLYGON: 1, CLEAR: 2, FULL_EXTENT: 3 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POLYGON_STYLE = Object.freeze({ fillColor: "#F2D27A", fillOpacity: 160, lineColor: "#D95D39", lineWidth: 2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let polygonLayerIndex = -1;
let polygonCursor = 0;

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

function samplePolygonAt(index) {
  const column = index % 7;
  const row = Math.floor(index / 7);
  const x = -124 + column * 7.5;
  const y = 27 + row * 4.2;
  return [
    [x, y],
    [x + 4.4, y + 0.2],
    [x + 5.6, y + 2.4],
    [x + 2.3, y + 3.4],
    [x - 0.4, y + 2],
    [x, y],
  ];
}

function addNextPolygon() {
  activatePolygonEditing();
  const points = samplePolygonAt(polygonCursor);
  if (!viewer.addPolygonToEditLayer(polygonLayerIndex, points)) throw new Error("Polygon could not be added.");
  polygonCursor += 1;
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateStatus(`addPolygonToEditLayer(${polygonLayerIndex}, ${points.length} vertices)`);
}

function clearPolygons() {
  if (!viewer.rollbackEditLayer(polygonLayerIndex)) throw new Error("The polygons could not be cleared.");
  activatePolygonEditing();
  polygonCursor = 0;
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateStatus("Programmatic polygons cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POLYGON) {
    addNextPolygon();
  } else if (commandId === COMMAND.CLEAR) {
    clearPolygons();
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
  viewer = new ViewerWindow({ title: "AddPolygonProgrammatic", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POLYGON, text: "Add Polygon" },
    { id: COMMAND.CLEAR, text: "Clear Polygons" },
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
    polygonLayerIndex = viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POLYGON, POLYGON_STYLE);
    if (polygonLayerIndex < 0) throw new Error("The programmatic polygon layer could not be created.");
    activatePolygonEditing();
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    updateStatus("Click Add Polygon to call addPolygonToEditLayer(index, points).");
  } catch (error) {
    viewer?.setStatusText("Programmatic polygon layer could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polygonLayerIndex = -1;
  polygonCursor = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
