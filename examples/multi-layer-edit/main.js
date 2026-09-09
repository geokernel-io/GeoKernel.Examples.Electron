"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ShapeType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 55);
const RED_LAYER_NAME = "Red Points";
const BLUE_LAYER_NAME = "Blue Points";

const COMMAND = Object.freeze({
  ACTIVE_RED: 1,
  ACTIVE_BLUE: 2,
  ADD_ACTIVE: 3,
  COMMIT_BOTH: 4,
  ROLLBACK_BOTH: 5,
  RESET: 6,
  FULL_EXTENT: 7,
});

const WORLD_STYLE = Object.freeze({
  fillColor: "#D8E5E1",
  fillOpacity: 210,
  lineColor: "#6F8883",
  lineWidth: 0.7,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let redLayerIndex = -1;
let blueLayerIndex = -1;
let activeLayerIndex = -1;
let redCursor = 0;
let blueCursor = 0;

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

function pointStyle(pointColor, lineColor) {
  return {
    pointColor,
    lineColor,
    pointSize: 11,
    lineWidth: 1.3,
    selectedLineColor: "#F59E0B",
    selectedLineWidth: 4,
    showLabels: true,
    labelField: "Name",
    labelFontSize: 10,
    labelColor: "#263238",
    labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF",
    labelHaloWidth: 2,
    labelOffsetY: -12,
    labelAllowOverlap: true,
  };
}

function redPointAt(index) {
  return [-124 + (index % 7) * 7.5, 31 + Math.floor(index / 7) * 5];
}

function bluePointAt(index) {
  return [-121.5 + (index % 7) * 7.5, 33 + Math.floor(index / 7) * 5];
}

function resolveEditLayerIndices() {
  redLayerIndex = Number(viewer.layerInfoByName(RED_LAYER_NAME)?.index ?? -1);
  blueLayerIndex = Number(viewer.layerInfoByName(BLUE_LAYER_NAME)?.index ?? -1);
  if (redLayerIndex < 0 || blueLayerIndex < 0) {
    throw new Error("Editable layer indices could not be resolved.");
  }
}

function createEditLayers() {
  const redResult = viewer.addEmptyVectorLayer(
    RED_LAYER_NAME,
    ShapeType.POINT,
    pointStyle("#D95D39", "#8C321D"),
  );
  if (redResult < 0) throw new Error("Red Points layer could not be created.");
  viewer.addLayerAttributeDefinition(redResult, "Name", 0, 64, 0);
  viewer.addLayerAttributeDefinition(redResult, "Layer", 0, 32, 0);

  const blueResult = viewer.addEmptyVectorLayer(
    BLUE_LAYER_NAME,
    ShapeType.POINT,
    pointStyle("#2563EB", "#1E3A8A"),
  );
  if (blueResult < 0) throw new Error("Blue Points layer could not be created.");
  viewer.addLayerAttributeDefinition(blueResult, "Name", 0, 64, 0);
  viewer.addLayerAttributeDefinition(blueResult, "Layer", 0, 32, 0);

  resolveEditLayerIndices();
}

function beginLayer(layerIndex) {
  if (layerIndex >= 0 && !viewer.isLayerEditing(layerIndex)) {
    if (!viewer.beginEditLayer(layerIndex)) {
      throw new Error(`BeginEditLayer(${layerIndex}) failed.`);
    }
  }
}

function beginBothLayers() {
  beginLayer(redLayerIndex);
  beginLayer(blueLayerIndex);
}

function activeLayerName() {
  if (activeLayerIndex === redLayerIndex) return RED_LAYER_NAME;
  if (activeLayerIndex === blueLayerIndex) return BLUE_LAYER_NAME;
  return "-";
}

function updateUi(message) {
  if (!viewer || redLayerIndex < 0 || blueLayerIndex < 0) return;
  const redCount = viewer.layerFeatureCount(redLayerIndex);
  const blueCount = viewer.layerFeatureCount(blueLayerIndex);
  viewer.setStatusText(
    `${message} Active edit layer: ${activeLayerName()} (${activeLayerIndex}) | `
    + `Red: ${redCount} | Blue: ${blueCount}`,
  );
  viewer.appendLog(
    `${message}\nActiveEditLayerIndex: ${activeLayerIndex} | Active layer: ${activeLayerName()} | `
    + `Red index/count: ${redLayerIndex}/${redCount} | Blue index/count: ${blueLayerIndex}/${blueCount}`,
  );
}

function setActiveLayer(layerIndex) {
  beginBothLayers();
  if (layerIndex < 0 || !viewer.setActiveEditLayerIndex(layerIndex)) {
    throw new Error(`SetActiveEditLayerIndex(${layerIndex}) failed.`);
  }
  activeLayerIndex = layerIndex;
  updateUi(`SetActiveEditLayerIndex(${layerIndex}).`);
}

function addToActiveLayer() {
  beginBothLayers();
  if (activeLayerIndex !== redLayerIndex && activeLayerIndex !== blueLayerIndex) {
    updateUi("No active edit layer.");
    return;
  }

  const redActive = activeLayerIndex === redLayerIndex;
  const cursor = redActive ? redCursor : blueCursor;
  const [x, y] = redActive ? redPointAt(cursor) : bluePointAt(cursor);
  const layerName = redActive ? RED_LAYER_NAME : BLUE_LAYER_NAME;
  const attributes = {
    Name: `${layerName} ${cursor + 1}`,
    Layer: layerName,
  };

  if (!viewer.addPointToEditLayer(activeLayerIndex, x, y, attributes)) {
    throw new Error(`AddPointToEditLayer(${activeLayerIndex}, ...) failed.`);
  }

  if (redActive) redCursor += 1;
  else blueCursor += 1;
  refreshMap();
  updateUi(`Added point to active layer: ${layerName}.`);
}

function commitIfEditing(layerIndex) {
  if (layerIndex >= 0 && viewer.isLayerEditing(layerIndex)) {
    if (!viewer.commitEditLayer(layerIndex)) {
      throw new Error(`CommitEditLayer(${layerIndex}) failed.`);
    }
  }
}

function rollbackIfEditing(layerIndex) {
  if (layerIndex >= 0 && viewer.isLayerEditing(layerIndex)) {
    if (!viewer.rollbackEditLayer(layerIndex)) {
      throw new Error(`RollbackEditLayer(${layerIndex}) failed.`);
    }
  }
}

function commitBoth() {
  const selectedName = activeLayerName();
  commitIfEditing(redLayerIndex);
  commitIfEditing(blueLayerIndex);
  beginBothLayers();
  setActiveLayer(selectedName === BLUE_LAYER_NAME ? blueLayerIndex : redLayerIndex);
  refreshMap();
  updateUi("Both edit layers committed and reopened for editing.");
}

function resetLayers(message) {
  rollbackIfEditing(redLayerIndex);
  rollbackIfEditing(blueLayerIndex);
  viewer.removeLayerByName(RED_LAYER_NAME);
  viewer.removeLayerByName(BLUE_LAYER_NAME);
  redLayerIndex = -1;
  blueLayerIndex = -1;
  activeLayerIndex = -1;
  redCursor = 0;
  blueCursor = 0;
  createEditLayers();
  beginBothLayers();
  setActiveLayer(redLayerIndex);
  refreshMap();
  updateUi(message);
}

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ACTIVE_RED) setActiveLayer(redLayerIndex);
  else if (commandId === COMMAND.ACTIVE_BLUE) setActiveLayer(blueLayerIndex);
  else if (commandId === COMMAND.ADD_ACTIVE) addToActiveLayer();
  else if (commandId === COMMAND.COMMIT_BOTH) commitBoth();
  else if (commandId === COMMAND.ROLLBACK_BOTH) {
    resetLayers("Both edit layers rolled back. Red Points is active.");
  } else if (commandId === COMMAND.RESET) {
    resetLayers("Both edit layers reset. Red Points is active.");
  } else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateUi("Sample extent restored.");
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
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "MultiLayerEdit",
    width: 1200,
    height: 800,
    navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: COMMAND.ACTIVE_RED, text: "Active: Red Points" },
    { id: COMMAND.ACTIVE_BLUE, text: "Active: Blue Points" },
    { id: COMMAND.ADD_ACTIVE, text: "Add To Active Layer", separatorBefore: true },
    { id: COMMAND.COMMIT_BOTH, text: "Commit Both" },
    { id: COMMAND.ROLLBACK_BOTH, text: "Rollback Both" },
    { id: COMMAND.RESET, text: "Reset" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("MultiLayerEdit sample");
  viewer.appendLog([
    "Workflow:",
    "1. Red Points and Blue Points are both editing.",
    "2. Active layer buttons call SetActiveEditLayerIndex(index).",
    "3. Add To Active Layer writes to the active edit layer.",
    "4. Commit Both commits and reopens both edit sessions.",
    "5. Rollback Both discards uncommitted additions.",
  ].join("\n"));
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(
    SAMPLE_URL,
    "world_4326.zip",
    "world_4326",
    "world_4326.shp",
  );
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  createEditLayers();
  beginBothLayers();
  setActiveLayer(redLayerIndex);
  viewer.setViewExtent(SAMPLE_EXTENT);
  refreshMap();
  viewer.processEvents();
  updateUi("Switch active edit layer, then add points to that layer.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  redLayerIndex = -1;
  blueLayerIndex = -1;
  activeLayerIndex = -1;
  redCursor = 0;
  blueCursor = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
