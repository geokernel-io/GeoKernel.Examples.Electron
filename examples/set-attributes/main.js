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
const SAMPLE_EXTENT = extent(-132, 18, -60, 55);
const POINTS = Object.freeze([[-122, 36], [-111, 42], [-101, 34.5], [-91, 41], [-80, 33]]);
const COMMAND = Object.freeze({ SELECT: 1, APPLY: 2, UNDO: 3, REDO: 4, RESET: 5, FULL_EXTENT: 6 });
const CONTROL = Object.freeze({ NAME: 1, STATUS: 2, PRIORITY: 3 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 170, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({
  pointColor: "#D95D39",
  pointSize: 11,
  lineColor: "#8C321D",
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
let selectedShapeId = -1;
let values = { Name: "Site 1", Status: "Planned", Priority: 1 };
let populating = false;
let pendingUpdate = false;

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
  if (pointLayerIndex < 0) throw new Error("Editable Attributes layer is missing.");
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error("Editable Attributes layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error("Editable Attributes layer could not be activated.");
  }
}

function selectedPointFeatures() {
  return viewer.selectedFeatures().filter((feature) => feature.layerIndex === pointLayerIndex);
}

function readRows() {
  const count = viewer.layerFeatureCount(pointLayerIndex);
  return Array.from({ length: count }, (_, rowIndex) => ({
    shapeId: rowIndex + 1,
    ...viewer.layerFeatureAttributes(pointLayerIndex, rowIndex),
  }));
}

function updateTable() {
  const rows = readRows();
  viewer.setLegendItems(rows.length > 0 ? rows.map((row) => ({
    shape: "point",
    style: POINT_STYLE,
    label: `${row.shapeId}  |  ${row.Name ?? ""}  |  ${row.Status ?? ""}  |  ${row.Priority ?? ""}`,
  })) : [{ shape: "none", label: "Shape ID | Name | Status | Priority" }]);
}

function updateInfo(message) {
  const canUndo = viewer.canUndoEditLayer(pointLayerIndex);
  const canRedo = viewer.canRedoEditLayer(pointLayerIndex);
  const lines = [
    "Attribute editor",
    `Selected shape: ${selectedShapeId > 0 ? selectedShapeId : "none"}`,
    `Name: ${values.Name}`,
    `Status: ${values.Status}`,
    `Priority: ${values.Priority}`,
    "",
    "API:",
    "setShapeAttributesInEditLayer(index, shapeId, attributes)",
    "",
    `Feature count: ${viewer.layerFeatureCount(pointLayerIndex)}`,
    `Can undo: ${canUndo}`,
    `Can redo: ${canRedo}`,
  ];
  viewer.clearLog();
  viewer.appendLog(lines.join("\n"));
  viewer.setStatusText(message);
}

function synchronizeControls() {
  viewer.setControlValue(CONTROL.NAME, values.Name);
  viewer.setControlValue(CONTROL.STATUS, values.Status);
  viewer.setControlValue(CONTROL.PRIORITY, values.Priority);
}

function clearSelection() {
  selectedShapeId = -1;
  values = { Name: "Site 1", Status: "Planned", Priority: 1 };
  viewer.clearSelectedFeatures();
  synchronizeControls();
}

function reset() {
  populating = true;
  try {
    if (viewer.isLayerEditing(pointLayerIndex) && !viewer.rollbackEditLayer(pointLayerIndex)) {
      throw new Error("Editable Attributes layer could not be reset.");
    }
    beginEditing();
    clearSelection();
    POINTS.forEach(([x, y], index) => {
      const attributes = {
        Name: `Site ${index + 1}`,
        Status: index % 2 === 0 ? "Planned" : "Active",
        Priority: index + 1,
      };
      if (!viewer.addPointToEditLayer(pointLayerIndex, x, y, attributes)) {
        throw new Error(`Site ${index + 1} could not be added.`);
      }
    });
  } finally {
    populating = false;
  }
  viewer.setTool(ViewerTool.INFO);
  refreshMap();
  updateTable();
  updateInfo("Select a point, edit attributes, then Apply Attributes.");
}

function applyAttributes() {
  if (selectedShapeId < 0) {
    updateInfo("Select a feature first.");
    return;
  }
  if (!viewer.setShapeAttributesInEditLayer(pointLayerIndex, selectedShapeId, values)) {
    updateInfo("setShapeAttributesInEditLayer failed.");
    return;
  }
  refreshMap();
  updateTable();
  updateInfo(`setShapeAttributesInEditLayer(${pointLayerIndex}, ${selectedShapeId}, attributes) succeeded.`);
}

function restoreSelectionFromRows() {
  if (selectedShapeId < 0) return;
  const row = readRows().find((candidate) => candidate.shapeId === selectedShapeId);
  if (!row) {
    clearSelection();
    return;
  }
  values = { Name: String(row.Name ?? ""), Status: String(row.Status ?? "Planned"), Priority: Number(row.Priority ?? 1) };
  synchronizeControls();
}

function runHistory(redo) {
  const succeeded = redo ? viewer.redoEditLayer(pointLayerIndex) : viewer.undoEditLayer(pointLayerIndex);
  restoreSelectionFromRows();
  refreshMap();
  updateTable();
  updateInfo(`${redo ? "redoEditLayer" : "undoEditLayer"}(${pointLayerIndex}) ${succeeded ? "succeeded." : "has no available step."}`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SELECT) {
    viewer.setTool(ViewerTool.INFO);
    updateInfo("Select mode is active. Click an editable point.");
  } else if (commandId === COMMAND.APPLY) applyAttributes();
  else if (commandId === COMMAND.UNDO) runHistory(false);
  else if (commandId === COMMAND.REDO) runHistory(true);
  else if (commandId === COMMAND.RESET) reset();
  else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateInfo("Sample extent restored.");
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

function onControlChanged(controlId, numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    if (controlId === CONTROL.NAME) values.Name = textValue;
    else if (controlId === CONTROL.STATUS) values.Status = textValue;
    else if (controlId === CONTROL.PRIORITY) values.Priority = Math.max(1, Math.min(10, Math.trunc(numericValue)));
    updateInfo("Attribute form values changed. Click Apply Attributes to save.");
  });
}

function selectAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const hit = viewer.hitTestFeaturesAt(x, y, 8)
    .find((feature) => feature.isValid && feature.layerIndex === pointLayerIndex);
  viewer.clearSelectedFeatures();
  if (!hit) {
    clearSelection();
    updateInfo("No editable point selected.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const worldTolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  if (!viewer.selectFeatureHit(hit, worldTolerance)) {
    clearSelection();
    updateInfo("Editable point could not be selected.");
    return;
  }
  selectedShapeId = Number(hit.shapeId ?? hit.featureId);
  const attributes = hit.attributes ?? {};
  values = {
    Name: String(attributes.Name ?? `Site ${selectedShapeId}`),
    Status: String(attributes.Status ?? "Planned"),
    Priority: Number(attributes.Priority ?? 1),
  };
  synchronizeControls();
  updateInfo(`Selected shape ${selectedShapeId}.`);
}

function scheduleDataUpdate() {
  if (pendingUpdate) return;
  pendingUpdate = true;
  setImmediate(() => {
    pendingUpdate = false;
    if (!viewer || populating) return;
    updateTable();
    updateInfo("Attribute edit history changed.");
  });
}

function onViewerEvent(event) {
  if (populating) return;
  if (event.eventType === ViewerEventType.MAP_MOUSE_UP && event.intValue === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { selectAt(event); } catch (error) { viewer?.setStatusText(`Selection failed: ${error.message}`); }
    });
  } else if (event.eventType === ViewerEventType.LAYER_EDIT_STATE_CHANGED) {
    scheduleDataUpdate();
  }
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
  viewer = new ViewerWindow({ title: "SetAttributes", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.APPLY, text: "Apply Attributes" },
    { id: COMMAND.UNDO, text: "Undo" },
    { id: COMMAND.REDO, text: "Redo" },
    { id: COMMAND.RESET, text: "Reset" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  const nameOptions = ["Site 1", "Site 2", "Site 3", "Site 4", "Site 5", "Updated Site", "Priority Site"];
  viewer.addControlPanel({
    title: "Attribute editor",
    area: "right",
    width: 280,
    controls: [
      { id: CONTROL.NAME, type: "combo", label: "Name", options: nameOptions, value: values.Name },
      { id: CONTROL.STATUS, type: "combo", label: "Status", options: ["Planned", "Active", "Done"], value: values.Status },
      { id: CONTROL.PRIORITY, type: "number", label: "Priority", value: values.Priority, minimum: 1, maximum: 10, step: 1, decimals: 0 },
    ],
  }, onControlChanged);
  viewer.addLegendPanel("Editable Attributes table");
  viewer.setLegendWidth(390);
  viewer.addLogPanel("Attribute state");
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.INFO);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  pointLayerIndex = viewer.addEmptyVectorLayer("Editable Attributes", ShapeType.POINT, POINT_STYLE);
  pointLayerIndex = Number(viewer.layerInfoByName("Editable Attributes")?.index ?? -1);
  if (pointLayerIndex < 0) throw new Error("Editable Attributes layer could not be created.");
  for (const [name, type, length] of [
    ["Name", AttributeType.STRING, 64],
    ["Status", AttributeType.STRING, 32],
    ["Priority", AttributeType.INTEGER, 8],
  ]) {
    if (!viewer.addLayerAttributeDefinition(pointLayerIndex, name, type, length, 0)) {
      throw new Error(`${name} attribute definition could not be added.`);
    }
  }
  reset();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateInfo("Select a point, edit form values, then Apply Attributes.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  selectedShapeId = -1;
  populating = false;
  pendingUpdate = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
