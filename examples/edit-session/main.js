"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-130, 20, -65, 52);
const INITIAL_POINTS = Object.freeze([
  [-122.4194, 37.7749],
  [-118.2437, 34.0522],
  [-112.074, 33.4484],
]);
const COMMAND = Object.freeze({ BEGIN_EDIT: 1, ADD_FEATURE: 2, COMMIT: 3, ROLLBACK: 4, FULL_EXTENT: 5 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({ pointColor: "#D85B35", lineColor: "#8C321D", pointSize: 9, lineWidth: 1.2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let editLayerIndex = -1;
let editPointCursor = 0;

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
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
}

function updateState(message) {
  const editing = editLayerIndex >= 0 && viewer.isLayerEditing(editLayerIndex);
  const featureCount = editLayerIndex >= 0 ? viewer.layerFeatureCount(editLayerIndex) : 0;
  viewer.setStatusText(`${message} Editing: ${editing ? "ON" : "OFF"} | Feature count: ${featureCount}`);
}

function generatedEditPoint(index) {
  const column = index % 11;
  const row = Math.floor(index / 11) % 6;
  const cycle = Math.floor(index / 66);
  return [-124 + column * 5.6 + cycle * 0.35, 25 + row * 4.2 + cycle * 0.35];
}

function beginEdit() {
  if (editLayerIndex < 0) throw new Error("Editable Cities layer is missing.");
  if (viewer.isLayerEditing(editLayerIndex)) {
    updateState("Edit session is already active.");
    return;
  }
  if (!viewer.beginEditLayer(editLayerIndex)) throw new Error("Edit session could not be started.");
  viewer.setActiveEditLayerIndex(editLayerIndex);
  updateState("Edit session started.");
}

function addFeature() {
  if (editLayerIndex < 0 || !viewer.isLayerEditing(editLayerIndex)) {
    updateState("Begin Edit before adding a feature.");
    return;
  }
  const [x, y] = generatedEditPoint(editPointCursor);
  if (!viewer.addPointToEditLayer(editLayerIndex, x, y)) throw new Error("Feature could not be added.");
  editPointCursor += 1;
  refreshMap();
  updateState("Feature added inside the active edit session.");
}

function commitEdit() {
  if (editLayerIndex < 0 || !viewer.isLayerEditing(editLayerIndex)) {
    updateState("No active edit session to commit.");
    return;
  }
  if (!viewer.commitEditLayer(editLayerIndex)) throw new Error("Edit session could not be committed.");
  refreshMap();
  updateState("Edit session committed. Added features remain in the layer.");
}

function rollbackEdit() {
  if (editLayerIndex < 0 || !viewer.isLayerEditing(editLayerIndex)) {
    updateState("No active edit session to roll back.");
    return;
  }
  if (!viewer.rollbackEditLayer(editLayerIndex)) throw new Error("Edit session could not be rolled back.");
  refreshMap();
  updateState("Edit session rolled back. Uncommitted features were removed.");
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
    try {
      handleCommand(commandId);
    } catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function createEditLayer() {
  editLayerIndex = viewer.addEmptyVectorLayer("Editable Cities", ShapeType.POINT, POINT_STYLE);
  editLayerIndex = Number(viewer.layerInfoByName("Editable Cities")?.index ?? -1);
  if (editLayerIndex < 0) throw new Error("Editable Cities layer could not be created.");
  if (!viewer.beginEditLayer(editLayerIndex)) throw new Error("Initial edit session could not be started.");
  viewer.setActiveEditLayerIndex(editLayerIndex);
  for (const [x, y] of INITIAL_POINTS) {
    if (!viewer.addPointToEditLayer(editLayerIndex, x, y)) throw new Error("Initial point could not be added.");
  }
  if (!viewer.commitEditLayer(editLayerIndex)) throw new Error("Initial points could not be committed.");
  refreshMap();
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
  viewer = new ViewerWindow({ title: "EditSession", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.BEGIN_EDIT, text: "Begin Edit" },
    { id: COMMAND.ADD_FEATURE, text: "Add Feature" },
    { id: COMMAND.COMMIT, text: "Commit Edit", separatorBefore: true },
    { id: COMMAND.ROLLBACK, text: "Rollback Edit" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  createEditLayer();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.processEvents();
  updateState("Ready. Start an edit session to add temporary features.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  editLayerIndex = -1;
  editPointCursor = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
