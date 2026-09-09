"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  AttributeType,
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
const POINT_LAYER_NAME = "Clicked Points";
const COMMAND = Object.freeze({ FULL_EXTENT: 1, ADD_POINT: 2, PAN: 3, SAVE: 4, CLEAR: 5 });
const SIDECAR_EXTENSIONS = Object.freeze([".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix"]);
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({ pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 9, lineWidth: 1.2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let addPointMode = false;

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

function outputShapefilePath() {
  return path.join(__dirname, "EditAndSaveData", "clicked_points.shp");
}

function removeExistingShapefile(shapefilePath) {
  const outputDirectory = path.resolve(path.dirname(shapefilePath));
  const expectedDirectory = path.resolve(path.join(__dirname, "EditAndSaveData"));
  if (outputDirectory !== expectedDirectory) throw new Error(`Refusing to remove files outside ${expectedDirectory}`);
  const basePath = path.join(outputDirectory, path.parse(shapefilePath).name);
  for (const extension of SIDECAR_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function pointCount() {
  return pointLayerIndex >= 0 ? viewer.layerFeatureCount(pointLayerIndex) : 0;
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Point count: ${pointCount()}`);
}

function beginPointEditing() {
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error("Clicked Points layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error("Clicked Points layer could not be activated for editing.");
  }
}

function activateAddPoint() {
  beginPointEditing();
  addPointMode = true;
  viewer.setTool(ViewerTool.ADD_POINT);
  updateStatus("Add Point active. Click the map to add points.");
}

function activatePan() {
  addPointMode = false;
  viewer.setTool(ViewerTool.PAN);
  updateStatus("Pan active.");
}

function savePoints() {
  if (pointCount() === 0) {
    updateStatus("There are no points to save.");
    return;
  }
  const destination = outputShapefilePath();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  removeExistingShapefile(destination);
  if (!viewer.saveLayerAsShapefile(pointLayerIndex, destination)) {
    throw new Error("Clicked Points shapefile could not be created.");
  }
  updateStatus(`Saved shapefile: ${destination}`);
}

function clearPoints() {
  const restoreAddPoint = addPointMode;
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.rollbackEditLayer(pointLayerIndex)) throw new Error("Clicked points could not be cleared.");
  beginPointEditing();
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  if (restoreAddPoint) viewer.setTool(ViewerTool.ADD_POINT);
  updateStatus("Clicked points cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.FULL_EXTENT) viewer.setViewExtent(SAMPLE_EXTENT);
  else if (commandId === COMMAND.ADD_POINT) activateAddPoint();
  else if (commandId === COMMAND.PAN) activatePan();
  else if (commandId === COMMAND.SAVE) savePoints();
  else if (commandId === COMMAND.CLEAR) clearPoints();
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
    if (!viewer || pointLayerIndex < 0) return;
    updateStatus(addPointMode ? "Point layer updated. Click the map to add points." : "Point layer updated.");
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
  viewer = new ViewerWindow({ title: "EditAndSave", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
    { id: COMMAND.ADD_POINT, text: "Add Point", separatorBefore: true },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.SAVE, text: "Save Shapefile", separatorBefore: true },
    { id: COMMAND.CLEAR, text: "Clear Points" },
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

  pointLayerIndex = viewer.addEmptyVectorLayer(POINT_LAYER_NAME, ShapeType.POINT, POINT_STYLE);
  pointLayerIndex = Number(viewer.layerInfoByName(POINT_LAYER_NAME)?.index ?? pointLayerIndex);
  if (pointLayerIndex < 0) throw new Error("Clicked Points layer could not be created.");
  viewer.addLayerAttributeDefinition(pointLayerIndex, "NAME", AttributeType.STRING, 80);
  viewer.addLayerAttributeDefinition(pointLayerIndex, "CREATED", AttributeType.STRING, 32);
  beginPointEditing();
  viewer.setEventCallback(onViewerEvent);
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  activateAddPoint();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  addPointMode = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
