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
const SAMPLE_EXTENT = extent(-132, 18, -60, 55);
const COMMAND = Object.freeze({ ADD_POINT: 1, UNDO: 2, REDO: 3, UNDO_FIVE: 4, REDO_FIVE: 5, RESET: 6, FULL_EXTENT: 7 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 180, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({ pointColor: "#D95D39", pointSize: 10, lineColor: "#8C321D", lineWidth: 1.2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let populating = false;
let pendingStateUpdate = false;

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

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function beginEditing() {
  if (pointLayerIndex < 0) throw new Error("Undo Redo Points layer is missing.");
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error("Undo Redo Points layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error("Undo Redo Points layer could not be activated.");
  }
}

function updateState(message = "Click the map to create an undoable edit step.") {
  if (!viewer || pointLayerIndex < 0) return;
  const featureCount = viewer.layerFeatureCount(pointLayerIndex);
  const canUndo = viewer.canUndoEditLayer(pointLayerIndex);
  const canRedo = viewer.canRedoEditLayer(pointLayerIndex);
  const lines = [
    "Interactive undo/redo:",
    "- Add Point: every map click creates one edit step.",
    "- Undo calls undoEditLayer(index).",
    "- Redo calls redoEditLayer(index).",
    "- Undo 5 / Redo 5 call the same API repeatedly.",
    "",
    `Layer index: ${pointLayerIndex}`,
    `Visible points: ${featureCount}`,
    `Can undo: ${canUndo}`,
    `Can redo: ${canRedo}`,
  ];
  viewer.clearLog();
  viewer.appendLog(lines.join("\n"));
  viewer.setStatusText(`${message} Visible points: ${featureCount} | Undo: ${canUndo ? "yes" : "no"} | Redo: ${canRedo ? "yes" : "no"}`);
}

function scheduleStateUpdate(message) {
  if (pendingStateUpdate) return;
  pendingStateUpdate = true;
  setImmediate(() => {
    pendingStateUpdate = false;
    if (viewer && !populating) updateState(message);
  });
}

function activateAddPoint() {
  beginEditing();
  viewer.setTool(ViewerTool.ADD_POINT);
  updateState("Add Point active. Click the map to create an undoable step.");
}

function reset() {
  populating = true;
  try {
    if (viewer.isLayerEditing(pointLayerIndex) && !viewer.rollbackEditLayer(pointLayerIndex)) {
      throw new Error("Undo Redo Points layer could not be reset.");
    }
    beginEditing();
    viewer.clearSelectedFeatures();
  } finally {
    populating = false;
  }
  viewer.setTool(ViewerTool.ADD_POINT);
  refreshMap();
  updateState("Reset complete. Click the map to create undoable edit steps.");
}

function runOnce(redo) {
  const succeeded = redo ? viewer.redoEditLayer(pointLayerIndex) : viewer.undoEditLayer(pointLayerIndex);
  refreshMap();
  const methodName = redo ? "redoEditLayer" : "undoEditLayer";
  updateState(`${methodName}(${pointLayerIndex}) ${succeeded ? "succeeded." : "has no available step."}`);
}

function runMany(redo) {
  let completed = 0;
  for (let index = 0; index < 5; index += 1) {
    const succeeded = redo ? viewer.redoEditLayer(pointLayerIndex) : viewer.undoEditLayer(pointLayerIndex);
    if (!succeeded) break;
    completed += 1;
  }
  refreshMap();
  updateState(`${redo ? "redo" : "undo"} called successfully ${completed} time(s).`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POINT) activateAddPoint();
  else if (commandId === COMMAND.UNDO) runOnce(false);
  else if (commandId === COMMAND.REDO) runOnce(true);
  else if (commandId === COMMAND.UNDO_FIVE) runMany(false);
  else if (commandId === COMMAND.REDO_FIVE) runMany(true);
  else if (commandId === COMMAND.RESET) reset();
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
  if (populating || event.eventType !== ViewerEventType.LAYER_EDIT_STATE_CHANGED) return;
  scheduleStateUpdate("Edit history changed.");
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
  viewer = new ViewerWindow({ title: "UndoRedo", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POINT, text: "Add Point" },
    { id: COMMAND.UNDO, text: "Undo" },
    { id: COMMAND.REDO, text: "Redo" },
    { id: COMMAND.UNDO_FIVE, text: "Undo 5" },
    { id: COMMAND.REDO_FIVE, text: "Redo 5" },
    { id: COMMAND.RESET, text: "Reset" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLogPanel("Undo / Redo state");
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.ADD_POINT);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  pointLayerIndex = viewer.addEmptyVectorLayer("Undo Redo Points", ShapeType.POINT, POINT_STYLE);
  pointLayerIndex = Number(viewer.layerInfoByName("Undo Redo Points")?.index ?? -1);
  if (pointLayerIndex < 0) throw new Error("Undo Redo Points layer could not be created.");
  reset();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateState("Click the map 5 times, then use Undo/Redo.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  populating = false;
  pendingStateUpdate = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
