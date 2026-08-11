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
const COMMAND = Object.freeze({ PAN: 1, SELECT: 2, RESET: 3, FULL_EXTENT: 4 });
const CONTROL = Object.freeze({ PART: 1, INSERT_INDEX: 2, INSERT: 3 });
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
let currentTool = ViewerTool.INFO;
let partIndex = 0;
let insertIndex = 2;
let vertices = [];
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
  if (polygonLayerIndex < 0) throw new Error("Insert Target layer is missing.");
  if (!viewer.isLayerEditing(polygonLayerIndex) && !viewer.beginEditLayer(polygonLayerIndex)) {
    throw new Error("Insert Target layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(polygonLayerIndex)) {
    throw new Error("Insert Target layer could not be activated.");
  }
}

function insertionPoint() {
  if (partIndex !== 0 || insertIndex <= 0 || insertIndex >= vertices.length) return null;
  const a = vertices[insertIndex - 1];
  const b = vertices[insertIndex];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  const divisor = length > 0 ? length : 1;
  const offset = length > 0 ? length * 0.22 : 1;
  return [
    (a[0] + b[0]) / 2 - (dy / divisor) * offset,
    (a[1] + b[1]) / 2 + (dx / divisor) * offset,
  ];
}

function updateInfo(message = "Select a polygon, then click Insert Vertex.") {
  const selected = selectedPolygonFeatures();
  const point = insertionPoint();
  const lines = [
    "Workflow:",
    "1. Choose Select and click the editable polygon.",
    "2. Choose the insertion index.",
    "3. Click Insert Vertex. A visible offset point is added near the segment.",
    "",
    `Layer index: ${polygonLayerIndex}`,
    `Selected features: ${selected.length}`,
    `Part index: ${partIndex}`,
    `Insert index: ${insertIndex}`,
    `Vertex count: ${Math.max(0, vertices.length - 1)}`,
    `Insertion point: ${point ? `${point[0].toFixed(3)}, ${point[1].toFixed(3)}` : "invalid"}`,
  ];
  viewer.clearLog();
  viewer.appendLog(lines.join("\n"));
  viewer.setStatusText(message);
}

function activatePan() {
  currentTool = ViewerTool.PAN;
  viewer.setTool(currentTool);
  updateInfo("Pan tool is active.");
}

function activateSelect() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(currentTool);
  updateInfo("Select mode is active. Click the editable polygon.");
}

function resetShape() {
  populating = true;
  try {
    if (viewer.isLayerEditing(polygonLayerIndex) && !viewer.rollbackEditLayer(polygonLayerIndex)) {
      throw new Error("Editable polygon could not be reset.");
    }
    beginEditing();
    viewer.clearSelectedFeatures();
    vertices = INITIAL_VERTICES.map(([x, y]) => [x, y]);
    if (!viewer.addPolygonToEditLayer(polygonLayerIndex, vertices, { Name: "Insert target" })) {
      throw new Error("Insert target polygon could not be added.");
    }
  } finally {
    populating = false;
  }
  partIndex = 0;
  insertIndex = 2;
  viewer.setControlValue(CONTROL.PART, partIndex);
  viewer.setControlValue(CONTROL.INSERT_INDEX, insertIndex);
  refreshMap();
  activateSelect();
  updateInfo("Shape reset. Select the polygon, then insert a vertex.");
}

function insertVertex() {
  if (selectedPolygonFeatures().length === 0) {
    updateInfo("Select a polygon first.");
    return;
  }
  const point = insertionPoint();
  if (!point) {
    updateInfo("Invalid part/index for selected feature.");
    return;
  }
  if (!viewer.insertSelectedFeatureVertexInEditLayer(partIndex, insertIndex, point[0], point[1])) {
    updateInfo("insertFeatureVertexInEditLayer failed.");
    return;
  }
  vertices.splice(insertIndex, 0, point);
  const usedIndex = insertIndex;
  insertIndex = Math.min(insertIndex + 1, vertices.length - 1);
  viewer.setControlValue(CONTROL.INSERT_INDEX, insertIndex);
  refreshMap();
  updateInfo(`insertFeatureVertexInEditLayer(feature, ${partIndex}, ${usedIndex}, point) succeeded.`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.PAN) activatePan();
  else if (commandId === COMMAND.SELECT) activateSelect();
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
    else if (controlId === CONTROL.INSERT_INDEX) {
      insertIndex = Math.max(1, Math.min(Math.trunc(numericValue), vertices.length - 1));
    } else if (controlId === CONTROL.INSERT) {
      insertVertex();
      return;
    }
    updateInfo("Insertion parameters updated.");
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
  viewer = new ViewerWindow({ title: "InsertVertex", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.RESET, text: "Reset Shape" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addControlPanel({
    title: "Insert vertex",
    width: 255,
    controls: [
      { id: CONTROL.PART, type: "number", label: "Part", value: 0, minimum: 0, maximum: 0, step: 1, decimals: 0 },
      { id: CONTROL.INSERT_INDEX, type: "number", label: "Insert index", value: 2, minimum: 1, maximum: 64, step: 1, decimals: 0 },
      { id: CONTROL.INSERT, type: "button", text: "Insert Vertex" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("insertFeatureVertexInEditLayer");
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
  polygonLayerIndex = viewer.addEmptyVectorLayer("Insert Target", ShapeType.POLYGON, POLYGON_STYLE);
  polygonLayerIndex = Number(viewer.layerInfoByName("Insert Target")?.index ?? -1);
  if (polygonLayerIndex < 0) throw new Error("Insert Target layer could not be created.");
  if (!viewer.addLayerAttributeDefinition(polygonLayerIndex, "Name", AttributeType.STRING, 64, 0)) {
    throw new Error("Name attribute definition could not be added.");
  }
  resetShape();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateInfo("Select a polygon, then click Insert Vertex.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polygonLayerIndex = -1;
  currentTool = ViewerTool.INFO;
  vertices = [];
  populating = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
