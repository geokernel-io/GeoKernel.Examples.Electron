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
const SAMPLE_EXTENT = extent(-130, 20, -65, 55);
const LAYER_NAME = "Editable Points";
const CONTROL_MODIFIER = 0x04000000;
const COMMAND = Object.freeze({ SELECT: 1, DELETE_ONE: 2, DELETE_SELECTED: 3, RESET: 4, FULL_EXTENT: 5 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({
  pointColor: "#D95D39",
  lineColor: "#8C321D",
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
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let selectMode = false;
let rows = [];

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

function samplePointAt(index) {
  return [-122 + (index % 8) * 7, 30 + Math.floor(index / 8) * 5];
}

function activateEditing() {
  if (pointLayerIndex < 0) throw new Error(`${LAYER_NAME} layer is not in the viewer.`);
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not be activated for editing.`);
  }
}

function selectedPointFeatures() {
  return viewer.selectedFeatures().filter((feature) => feature.layerIndex === pointLayerIndex);
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Feature count: ${rows.length} | Selected: ${selectedPointFeatures().length}`);
}

function updateFeaturePanel(selectedIds = new Set(selectedPointFeatures().map((feature) => feature.shapeId))) {
  const items = rows.length > 0
    ? rows.map((row) => ({
      shape: "none",
      label: `${selectedIds.has(row.shapeId) ? ">" : " "} ${row.shapeId}  |  ${row.Name}  |  ${row.Group}  |  ${row.Value}`,
    }))
    : [{ shape: "none", label: "Feature ID  |  Name  |  Group  |  Value" }];
  viewer.setLegendItems(items);
}

function showSelection(message) {
  viewer.clearLog();
  viewer.appendLog(message);
}

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function populatePoints() {
  if (viewer.isLayerEditing(pointLayerIndex) && !viewer.rollbackEditLayer(pointLayerIndex)) {
    throw new Error("Editable points could not be reset.");
  }
  activateEditing();
  viewer.clearSelectedFeatures();
  rows = [];
  for (let index = 0; index < 16; index += 1) {
    const shapeId = index + 1;
    const [x, y] = samplePointAt(index);
    const attributes = {
      Name: `Point ${shapeId}`,
      Group: index % 2 === 0 ? "A" : "B",
      Value: shapeId * 5,
    };
    if (!viewer.addPointToEditLayer(pointLayerIndex, x, y, attributes)) {
      throw new Error(`Point ${shapeId} could not be added.`);
    }
    rows.push({ shapeId, ...attributes });
  }
  refreshMap();
  updateFeaturePanel(new Set());
  showSelection("Select mode: click a point. Ctrl+click toggles multiple selection.");
  updateStatus("Points reset.");
}

function activateSelect() {
  selectMode = true;
  viewer.setTool(ViewerTool.INFO);
  updateStatus("Select mode: click a point. Ctrl+click toggles multiple selection.");
}

function deleteOneFeature() {
  const selected = selectedPointFeatures();
  if (selected.length === 0) {
    updateStatus("Select a feature first.");
    return;
  }
  activateEditing();
  const feature = selected[0];
  if (!viewer.deleteShapeFromEditLayer(pointLayerIndex, feature.shapeId)) {
    throw new Error("deleteShapeFromEditLayer failed.");
  }
  rows = rows.filter((row) => row.shapeId !== feature.shapeId);
  viewer.clearSelectedFeatures();
  refreshMap();
  updateFeaturePanel(new Set());
  showSelection(`Deleted feature ${feature.featureId} with deleteShapeFromEditLayer(index, shapeId).`);
  updateStatus(`Deleted feature ${feature.featureId}.`);
}

function deleteSelectedFeatures() {
  const selected = selectedPointFeatures();
  if (selected.length === 0) {
    updateStatus("Select one or more features first.");
    return;
  }
  activateEditing();
  const deletedIds = new Set(selected.map((feature) => feature.shapeId));
  if (!viewer.deleteSelectedFeaturesFromEditLayer()) {
    throw new Error("deleteSelectedFeaturesFromEditLayer failed.");
  }
  rows = rows.filter((row) => !deletedIds.has(row.shapeId));
  viewer.clearSelectedFeatures();
  refreshMap();
  updateFeaturePanel(new Set());
  showSelection(`Deleted ${deletedIds.size} selected feature(s) with deleteSelectedFeaturesFromEditLayer().`);
  updateStatus(`Deleted ${deletedIds.size} selected feature(s).`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SELECT) activateSelect();
  else if (commandId === COMMAND.DELETE_ONE) deleteOneFeature();
  else if (commandId === COMMAND.DELETE_SELECTED) deleteSelectedFeatures();
  else if (commandId === COMMAND.RESET) populatePoints();
  else if (commandId === COMMAND.FULL_EXTENT) {
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

function selectAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const hit = viewer.hitTestTopFeatureAt(x, y, 8);
  if (!hit?.isValid || hit.layerIndex !== pointLayerIndex) {
    viewer.clearSelectedFeatures();
    updateFeaturePanel(new Set());
    showSelection("No editable point feature found.");
    updateStatus("No editable point feature found.");
    return;
  }
  const modifiers = Math.trunc(event.doubleValue);
  if ((modifiers & CONTROL_MODIFIER) !== 0) viewer.toggleTopFeatureSelectionAt(x, y, 8);
  else viewer.selectTopFeatureAt(x, y, 8);
  const selected = selectedPointFeatures();
  updateFeaturePanel(new Set(selected.map((feature) => feature.shapeId)));
  const lines = [`Selected feature count: ${selected.length}`];
  for (const feature of selected) lines.push(`Feature ${feature.featureId}: ${feature.attributes?.Name ?? "-"}`);
  showSelection(lines.join("\n"));
  updateStatus(`Selected feature ${hit.featureId}.`);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    selectMode = event.intValue === ViewerTool.INFO;
    return;
  }
  if (event.eventType === ViewerEventType.SELECTION_CHANGED) {
    setImmediate(() => {
      if (!viewer) return;
      updateFeaturePanel();
    });
    return;
  }
  if (event.eventType !== ViewerEventType.MAP_MOUSE_UP || !selectMode || event.intValue !== ViewerTool.INFO) return;
  setImmediate(() => {
    if (!viewer) return;
    try {
      selectAt(event);
    } catch (error) {
      viewer?.setStatusText(`Selection failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function createEditableLayer() {
  pointLayerIndex = viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POINT, POINT_STYLE);
  if (pointLayerIndex < 0) throw new Error("Editable Points layer could not be created.");
  const definitions = [
    ["Name", AttributeType.STRING, 64],
    ["Group", AttributeType.STRING, 32],
    ["Value", AttributeType.INTEGER, 8],
  ];
  for (const [name, type, length] of definitions) {
    if (!viewer.addLayerAttributeDefinition(pointLayerIndex, name, type, length, 0)) {
      throw new Error(`Attribute definition '${name}' could not be added.`);
    }
  }
  activateEditing();
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
  viewer = new ViewerWindow({ title: "DeleteFeature", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.DELETE_ONE, text: "Delete Feature" },
    { id: COMMAND.DELETE_SELECTED, text: "Delete Selected" },
    { id: COMMAND.RESET, text: "Reset Points" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLegendPanel("Editable point features");
  viewer.setLegendWidth(410);
  viewer.addLogPanel("Selection");
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  updateFeaturePanel(new Set());
  showSelection("Select mode: click a point. Ctrl+click toggles multiple selection.");
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
    createEditableLayer();
    populatePoints();
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    activateSelect();
  } catch (error) {
    viewer?.setStatusText("DeleteFeature could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  selectMode = false;
  rows = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
