"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const LAYER_NAME = "Programmatic Points";
const COMMAND = Object.freeze({ ADD_POINT: 1, CLEAR: 2, FULL_EXTENT: 3 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({ pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 9.5, lineWidth: 1.2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let pointCursor = 0;

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

function pointCount() {
  return pointLayerIndex >= 0 ? viewer.layerFeatureCount(pointLayerIndex) : 0;
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Point count: ${pointCount()}`);
}

function activatePointEditing() {
  if (pointLayerIndex < 0) throw new Error(`${LAYER_NAME} layer is not in the viewer.`);
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not be activated for editing.`);
  }
}

function samplePointAt(index) {
  const columns = 29;
  const rows = 13;
  const cell = index % (columns * rows);
  const column = (cell * 7) % columns;
  const row = (Math.floor(cell / columns) + (cell * 11)) % rows;
  return [-124 + column * 1.9, 26 + row * 1.8];
}

function addNextPoint() {
  activatePointEditing();
  const [x, y] = samplePointAt(pointCursor);
  if (!viewer.addPointToEditLayer(pointLayerIndex, x, y)) throw new Error("Point could not be added.");
  pointCursor += 1;
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateStatus(`addPointToEditLayer(${pointLayerIndex}, [${x.toFixed(4)}, ${y.toFixed(4)}])`);
}

function clearPoints() {
  if (!viewer.rollbackEditLayer(pointLayerIndex)) throw new Error("The points could not be cleared.");
  activatePointEditing();
  pointCursor = 0;
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateStatus("Programmatic points cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POINT) {
    addNextPoint();
  } else if (commandId === COMMAND.CLEAR) {
    clearPoints();
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
  viewer = new ViewerWindow({ title: "AddPointProgrammatic", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POINT, text: "Add Point" },
    { id: COMMAND.CLEAR, text: "Clear Points" },
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
    pointLayerIndex = viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POINT, POINT_STYLE);
    if (pointLayerIndex < 0) throw new Error("The programmatic point layer could not be created.");
    activatePointEditing();
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    updateStatus("Click Add Point to call addPointToEditLayer(index, worldPoint).");
  } catch (error) {
    viewer?.setStatusText("Programmatic point layer could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  pointCursor = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
