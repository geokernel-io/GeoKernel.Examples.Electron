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
const POINT_STYLE = Object.freeze({ pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 9.5, lineWidth: 1.2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let editLayerIndex = -1;
let editPointCursor = 0;
let editStateSignalCount = 0;
let initializing = false;
let pendingSignalUpdate = false;

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

function layerState() {
  const hasLayer = editLayerIndex >= 0;
  return {
    hasLayer,
    editing: hasLayer && viewer.isLayerEditing(editLayerIndex),
    dirty: hasLayer && viewer.isLayerDirty(editLayerIndex),
    featureCount: hasLayer ? viewer.layerFeatureCount(editLayerIndex) : 0,
  };
}

function updateState(message) {
  const state = layerState();
  viewer.setStatusText(
    `${message} Layer index: ${editLayerIndex} | Editing: ${state.editing ? "ON" : "OFF"} | `
    + `Dirty: ${state.dirty ? "YES" : "NO"} | Signals: ${editStateSignalCount} | Feature count: ${state.featureCount}`,
  );
}

function beginEdit() {
  const state = layerState();
  if (!state.hasLayer) throw new Error("Dirty State Points layer is missing.");
  if (state.editing) {
    updateState("Edit session is already active.");
    return;
  }
  if (!viewer.beginEditLayer(editLayerIndex)) {
    updateState("beginEditLayer failed.");
    return;
  }
  viewer.setActiveEditLayerIndex(editLayerIndex);
  appendLog(`beginEditLayer(${editLayerIndex}); isLayerDirty=${viewer.isLayerDirty(editLayerIndex)}`);
  updateState("Edit session started. Dirty is still false until a change is made.");
}

function generatedEditPoint(index) {
  const column = index % 8;
  const row = Math.floor(index / 8) % 4;
  return [-124 + column * 7.5, 25 + row * 5.2];
}

function addFeature() {
  if (!viewer.isLayerEditing(editLayerIndex)) {
    updateState("Begin Edit before adding a feature.");
    return;
  }
  const [x, y] = generatedEditPoint(editPointCursor);
  if (!viewer.addPointToEditLayer(editLayerIndex, x, y)) {
    updateState("addPointToEditLayer failed.");
    return;
  }
  editPointCursor += 1;
  appendLog(`addPointToEditLayer(${editLayerIndex}); isLayerDirty=${viewer.isLayerDirty(editLayerIndex)}`);
  refreshMap();
  updateState("Feature added. isLayerDirty(index) is now true.");
}

function commitEdit() {
  if (!viewer.isLayerEditing(editLayerIndex)) {
    updateState("No active edit session to commit.");
    return;
  }
  if (!viewer.commitEditLayer(editLayerIndex)) {
    updateState("commitEditLayer failed.");
    return;
  }
  appendLog(`commitEditLayer(${editLayerIndex}); isLayerDirty=${viewer.isLayerDirty(editLayerIndex)}`);
  refreshMap();
  updateState("Edit committed. isLayerDirty(index) returned to false.");
}

function rollbackEdit() {
  if (!viewer.isLayerEditing(editLayerIndex)) {
    updateState("No active edit session to roll back.");
    return;
  }
  if (!viewer.rollbackEditLayer(editLayerIndex)) {
    updateState("rollbackEditLayer failed.");
    return;
  }
  appendLog(`rollbackEditLayer(${editLayerIndex}); isLayerDirty=${viewer.isLayerDirty(editLayerIndex)}`);
  refreshMap();
  updateState("Edit rolled back. isLayerDirty(index) returned to false.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.BEGIN_EDIT) beginEdit();
  else if (commandId === COMMAND.ADD_FEATURE) addFeature();
  else if (commandId === COMMAND.COMMIT) commitEdit();
  else if (commandId === COMMAND.ROLLBACK) rollbackEdit();
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
  const watched = new Set([
    ViewerEventType.LAYER_EDIT_STATE_CHANGED,
    ViewerEventType.LAYER_EDIT_SESSION_STARTED,
    ViewerEventType.LAYER_EDIT_SESSION_COMMITTED,
    ViewerEventType.LAYER_EDIT_SESSION_ROLLED_BACK,
  ]);
  if (!watched.has(event.eventType) || pendingSignalUpdate) return;
  pendingSignalUpdate = true;
  setImmediate(() => {
    pendingSignalUpdate = false;
    if (!viewer) return;
    editStateSignalCount += 1;
    const state = layerState();
    appendLog(`signal ${event.eventTypeName ?? event.eventType}; isLayerDirty=${state.dirty}; editing=${state.editing}`);
    updateState("Edit state signal received.");
  });
}

function createInitialLayer() {
  editLayerIndex = viewer.addEmptyVectorLayer("Dirty State Points", ShapeType.POINT, POINT_STYLE);
  editLayerIndex = Number(viewer.layerInfoByName("Dirty State Points")?.index ?? -1);
  if (editLayerIndex < 0) throw new Error("Dirty State Points layer could not be created.");
  initializing = true;
  try {
    if (!viewer.beginEditLayer(editLayerIndex)) throw new Error("Initial edit session could not be started.");
    viewer.setActiveEditLayerIndex(editLayerIndex);
    for (const [x, y] of INITIAL_POINTS) {
      if (!viewer.addPointToEditLayer(editLayerIndex, x, y)) throw new Error("Initial point could not be added.");
    }
    if (!viewer.commitEditLayer(editLayerIndex)) throw new Error("Initial points could not be committed.");
  } finally {
    initializing = false;
  }
  refreshMap();
  appendLog(`Ready. Initial isLayerDirty=${viewer.isLayerDirty(editLayerIndex)}`);
  updateState("Use Add Feature to turn isLayerDirty on, then commit or rollback.");
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
  viewer = new ViewerWindow({ title: "EditDirtyState", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.BEGIN_EDIT, text: "Begin Edit" },
    { id: COMMAND.ADD_FEATURE, text: "Add Feature" },
    { id: COMMAND.COMMIT, text: "Commit Edit", separatorBefore: true },
    { id: COMMAND.ROLLBACK, text: "Rollback Edit" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("layerEditStateChanged log");
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
  updateState("Use Add Feature to turn isLayerDirty on, then commit or rollback.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  editLayerIndex = -1;
  editPointCursor = 0;
  editStateSignalCount = 0;
  initializing = false;
  pendingSignalUpdate = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
