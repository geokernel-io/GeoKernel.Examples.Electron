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
const SAMPLE_EXTENT = extent(-132, 15, -55, 55);
const INITIAL_VERTICES = Object.freeze([[-119, 28], [-109, 45], [-91, 42], [-83, 30], [-99, 22], [-115, 23.5], [-119, 28]]);
const COMMAND = Object.freeze({ EDIT_VERTICES: 1, SELECT: 2, DELETE_ACTIVE: 3, RESET: 4, FULL_EXTENT: 5 });
const CONTROL = Object.freeze({ PART: 1, VERTEX_INDEX: 2, DELETE_BY_INDEX: 3 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POLYGON_STYLE = Object.freeze({
  fillColor: "#F2D27A",
  fillOpacity: 160,
  lineColor: "#D95D39",
  lineWidth: 2,
  selectedLineColor: "#F59E0B",
  selectedLineWidth: 4,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let polygonLayerIndex = -1;
let currentTool = ViewerTool.EDIT_VERTICES;
let partIndex = 0;
let vertexIndex = 2;
let vertexCount = INITIAL_VERTICES.length;
let populating = false;

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

function selectedPolygonFeatures() {
  return viewer.selectedFeatures().filter((feature) => feature.layerIndex === polygonLayerIndex);
}

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function beginEditing() {
  if (polygonLayerIndex < 0) throw new Error("Delete Target layer is missing.");
  if (!viewer.isLayerEditing(polygonLayerIndex) && !viewer.beginEditLayer(polygonLayerIndex)) {
    throw new Error("Delete Target layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(polygonLayerIndex)) {
    throw new Error("Delete Target layer could not be activated.");
  }
}

function updateInfo(message) {
  const selected = selectedPolygonFeatures();
  const lines = [
    "Workflow:",
    "- Edit Vertices: click a vertex, then Delete Selected Vertex.",
    "- Select: click polygon, choose part/index, then Delete By Index.",
    "",
    "APIs:",
    "deleteSelectedVertexFromEditLayer()",
    "deleteFeatureVertexInEditLayer(feature, part, index)",
    "",
    `Layer index: ${polygonLayerIndex}`,
    `Selected features: ${selected.length}`,
    `Part index: ${partIndex}`,
    `Delete index: ${vertexIndex}`,
    `Vertex count: ${vertexCount}`,
  ];
  viewer.clearLog();
  viewer.appendLog(lines.join("\n"));
  viewer.setStatusText(message);
}

function activateEditVertices() {
  beginEditing();
  currentTool = ViewerTool.EDIT_VERTICES;
  viewer.setTool(currentTool);
  updateInfo("Edit Vertices is active. Click a vertex before deleting it.");
}

function activateSelect() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(currentTool);
  updateInfo("Select is active. Click the editable polygon.");
}

function resetShape() {
  populating = true;
  try {
    if (viewer.isLayerEditing(polygonLayerIndex) && !viewer.rollbackEditLayer(polygonLayerIndex)) {
      throw new Error("Editable polygon could not be reset.");
    }
    beginEditing();
    viewer.clearSelectedFeatures();
    if (!viewer.addPolygonToEditLayer(
      polygonLayerIndex,
      INITIAL_VERTICES.map(([x, y]) => [x, y]),
      { Name: "Delete target" },
    )) {
      throw new Error("Delete target polygon could not be added.");
    }
  } finally {
    populating = false;
  }
  partIndex = 0;
  vertexIndex = 2;
  vertexCount = INITIAL_VERTICES.length;
  viewer.setControlValue(CONTROL.PART, partIndex);
  viewer.setControlValue(CONTROL.VERTEX_INDEX, vertexIndex);
  refreshMap();
  activateEditVertices();
  updateInfo("Shape reset. Click a vertex or select the polygon.");
}

function deleteActiveVertex() {
  if (!viewer.deleteSelectedVertexFromEditLayer()) {
    updateInfo("No active vertex. Use Edit Vertices and click a vertex first.");
    return;
  }
  vertexCount = Math.max(0, vertexCount - 1);
  vertexIndex = Math.min(vertexIndex, Math.max(0, vertexCount - 1));
  viewer.setControlValue(CONTROL.VERTEX_INDEX, vertexIndex);
  refreshMap();
  updateInfo("deleteSelectedVertexFromEditLayer() succeeded.");
}

function deleteByIndex() {
  if (selectedPolygonFeatures().length === 0) {
    updateInfo("Select the polygon first.");
    return;
  }
  if (partIndex !== 0 || vertexIndex < 0 || vertexIndex >= vertexCount) {
    updateInfo("Invalid part/index for selected feature.");
    return;
  }
  const deletedIndex = vertexIndex;
  if (!viewer.deleteSelectedFeatureVertexInEditLayer(partIndex, deletedIndex)) {
    updateInfo("deleteFeatureVertexInEditLayer failed.");
    return;
  }
  vertexCount = Math.max(0, vertexCount - 1);
  vertexIndex = Math.min(vertexIndex, Math.max(0, vertexCount - 1));
  viewer.setControlValue(CONTROL.VERTEX_INDEX, vertexIndex);
  refreshMap();
  updateInfo(`deleteFeatureVertexInEditLayer(feature, ${partIndex}, ${deletedIndex}) succeeded.`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.EDIT_VERTICES) activateEditVertices();
  else if (commandId === COMMAND.SELECT) activateSelect();
  else if (commandId === COMMAND.DELETE_ACTIVE) deleteActiveVertex();
  else if (commandId === COMMAND.RESET) resetShape();
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

function onControlChanged(controlId, numericValue) {
  setImmediate(() => {
    if (!viewer) return;
    if (controlId === CONTROL.PART) partIndex = Math.max(0, Math.trunc(numericValue));
    else if (controlId === CONTROL.VERTEX_INDEX) {
      vertexIndex = Math.max(0, Math.min(Math.trunc(numericValue), Math.max(0, vertexCount - 1)));
    } else if (controlId === CONTROL.DELETE_BY_INDEX) {
      deleteByIndex();
      return;
    }
    updateInfo("Delete parameters updated.");
  });
}

function selectAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const hit = viewer.hitTestFeaturesAt(x, y, 8)
    .find((feature) => feature.isValid && feature.layerIndex === polygonLayerIndex);
  viewer.clearSelectedFeatures();
  if (!hit) {
    updateInfo("No editable polygon selected.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const worldTolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  if (!viewer.selectFeatureHit(hit, worldTolerance)) {
    updateInfo("Editable polygon could not be selected.");
    return;
  }
  updateInfo(`Selected feature ${hit.featureId}.`);
}

function onViewerEvent(event) {
  if (populating) return;
  if (event.eventType === ViewerEventType.MAP_MOUSE_UP && currentTool === ViewerTool.INFO && event.intValue === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { selectAt(event); } catch (error) { viewer?.setStatusText(`Selection failed: ${error.message}`); }
    });
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
  viewer = new ViewerWindow({ title: "DeleteVertex", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.EDIT_VERTICES, text: "Edit Vertices" },
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.DELETE_ACTIVE, text: "Delete Selected Vertex" },
    { id: COMMAND.RESET, text: "Reset Shape" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addControlPanel({
    title: "Delete by index",
    width: 255,
    controls: [
      { id: CONTROL.PART, type: "number", label: "Part", value: 0, minimum: 0, maximum: 0, step: 1, decimals: 0 },
      { id: CONTROL.VERTEX_INDEX, type: "number", label: "Vertex index", value: 2, minimum: 0, maximum: 64, step: 1, decimals: 0 },
      { id: CONTROL.DELETE_BY_INDEX, type: "button", text: "Delete By Index" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Delete vertex APIs");
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.EDIT_VERTICES);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  polygonLayerIndex = viewer.addEmptyVectorLayer("Delete Target", ShapeType.POLYGON, POLYGON_STYLE);
  polygonLayerIndex = Number(viewer.layerInfoByName("Delete Target")?.index ?? -1);
  if (polygonLayerIndex < 0) throw new Error("Delete Target layer could not be created.");
  if (!viewer.addLayerAttributeDefinition(polygonLayerIndex, "Name", AttributeType.STRING, 64, 0)) {
    throw new Error("Name attribute definition could not be added.");
  }
  resetShape();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateInfo("Use Edit Vertices for active vertex delete, or Select + index for direct API delete.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polygonLayerIndex = -1;
  currentTool = ViewerTool.EDIT_VERTICES;
  vertexCount = INITIAL_VERTICES.length;
  populating = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
