"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ShapeType,
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const INITIAL_POINTS = Object.freeze([[-122.4194, 37.7749], [-118.2437, 34.0522], [-112.074, 33.4484]]);
const COMMAND = Object.freeze({ BEGIN_EDIT: 1, ADD_FEATURE: 2, COMMIT: 3, ROLLBACK: 4, FULL_EXTENT: 5 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({ pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 10, lineWidth: 1.2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let layerIndex = -1;
let pointCursor = 0;
let startedCount = 0;
let committedCount = 0;
let rolledBackCount = 0;
let initializing = false;

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

function timestamp() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false, fractionalSecondDigits: 3 });
}

function appendLog(text) {
  viewer.appendLog(`${timestamp()} | ${text}`);
}

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function updateState(message) {
  const editing = layerIndex >= 0 && viewer.isLayerEditing(layerIndex);
  const featureCount = layerIndex >= 0 ? viewer.layerFeatureCount(layerIndex) : 0;
  viewer.setStatusText(
    `${message} Editing: ${editing ? "ON" : "OFF"} | Started: ${startedCount} | `
    + `Committed: ${committedCount} | Rolled back: ${rolledBackCount} | Feature count: ${featureCount}`,
  );
}

function beginEdit() {
  if (layerIndex < 0) throw new Error("Session Signal Points layer is missing.");
  if (viewer.isLayerEditing(layerIndex)) {
    updateState("Edit session is already active.");
    return;
  }
  if (!viewer.beginEditLayer(layerIndex)) {
    updateState("beginEditLayer failed.");
    return;
  }
  viewer.setActiveEditLayerIndex(layerIndex);
  appendLog(`call beginEditLayer(${layerIndex})`);
  updateState("Edit session started.");
}

function generatedPoint(index) {
  return [-122 + (index % 10) * 5, 29 + Math.floor(index / 10) * 4];
}

function addFeature() {
  if (!viewer.isLayerEditing(layerIndex)) beginEdit();
  if (!viewer.isLayerEditing(layerIndex)) return;
  const [x, y] = generatedPoint(pointCursor);
  if (!viewer.addPointToEditLayer(layerIndex, x, y)) {
    updateState("addPointToEditLayer failed.");
    return;
  }
  pointCursor += 1;
  appendLog(`call addPointToEditLayer(${layerIndex})`);
  refreshMap();
  updateState("Feature added inside the active edit session.");
}

function commit() {
  if (!viewer.isLayerEditing(layerIndex)) {
    updateState("No active edit session to commit.");
    return;
  }
  if (!viewer.commitEditLayer(layerIndex)) {
    updateState("commitEditLayer failed.");
    return;
  }
  appendLog(`call commitEditLayer(${layerIndex})`);
  refreshMap();
  updateState("Edit session committed.");
}

function rollback() {
  if (!viewer.isLayerEditing(layerIndex)) {
    updateState("No active edit session to roll back.");
    return;
  }
  if (!viewer.rollbackEditLayer(layerIndex)) {
    updateState("rollbackEditLayer failed.");
    return;
  }
  appendLog(`call rollbackEditLayer(${layerIndex})`);
  refreshMap();
  updateState("Edit session rolled back.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.BEGIN_EDIT) beginEdit();
  else if (commandId === COMMAND.ADD_FEATURE) addFeature();
  else if (commandId === COMMAND.COMMIT) commit();
  else if (commandId === COMMAND.ROLLBACK) rollback();
  else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateState("Sample extent restored.");
  }
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    try { handleCommand(commandId); } catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onViewerEvent(event) {
  if (initializing) return;
  let signalName = null;
  if (event.eventType === ViewerEventType.LAYER_EDIT_SESSION_STARTED) {
    startedCount += 1;
    signalName = "layerEditSessionStarted";
  } else if (event.eventType === ViewerEventType.LAYER_EDIT_SESSION_COMMITTED) {
    committedCount += 1;
    signalName = "layerEditSessionCommitted";
  } else if (event.eventType === ViewerEventType.LAYER_EDIT_SESSION_ROLLED_BACK) {
    rolledBackCount += 1;
    signalName = "layerEditSessionRolledBack";
  }
  if (!signalName) return;
  setImmediate(() => {
    if (!viewer) return;
    appendLog(`signal ${signalName}(Session Signal Points)`);
    updateState(`${signalName} signal received.`);
  });
}

function createInitialLayer() {
  layerIndex = viewer.addEmptyVectorLayer("Session Signal Points", ShapeType.POINT, POINT_STYLE);
  layerIndex = Number(viewer.layerInfoByName("Session Signal Points")?.index ?? -1);
  if (layerIndex < 0) throw new Error("Session Signal Points layer could not be created.");
  initializing = true;
  try {
    if (!viewer.beginEditLayer(layerIndex)) throw new Error("Initial edit session could not be started.");
    viewer.setActiveEditLayerIndex(layerIndex);
    for (const [x, y] of INITIAL_POINTS) {
      if (!viewer.addPointToEditLayer(layerIndex, x, y)) throw new Error("Initial point could not be added.");
    }
    if (!viewer.commitEditLayer(layerIndex)) throw new Error("Initial points could not be committed.");
  } finally {
    initializing = false;
  }
  refreshMap();
  appendLog("Ready. Waiting for edit session signals.");
  updateState("Begin an edit session, add a feature, then commit or rollback to see session signals.");
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
  viewer = new ViewerWindow({ title: "EditSessionSignals", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.BEGIN_EDIT, text: "Begin Edit" },
    { id: COMMAND.ADD_FEATURE, text: "Add Feature" },
    { id: COMMAND.COMMIT, text: "Commit Edit", separatorBefore: true },
    { id: COMMAND.ROLLBACK, text: "Rollback Edit" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("Edit session signal log");
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  createInitialLayer();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateState("Begin an edit session, add a feature, then commit or rollback to see session signals.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  layerIndex = -1;
  pointCursor = 0;
  startedCount = 0;
  committedCount = 0;
  rolledBackCount = 0;
  initializing = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
