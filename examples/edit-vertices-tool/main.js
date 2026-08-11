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
const COMMAND = Object.freeze({ PAN: 1, EDIT_VERTICES: 2, DELETE_VERTEX: 3, RESET: 4, FULL_EXTENT: 5 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const LINE_STYLE = Object.freeze({ lineColor: "#D95D39", lineWidth: 2.6, selectedLineColor: "#F59E0B", selectedLineWidth: 4 });
const POLYGON_STYLE = Object.freeze({ fillColor: "#F2D27A", fillOpacity: 120, lineColor: "#2878A0", lineWidth: 2, selectedLineColor: "#F59E0B", selectedLineWidth: 4 });

const FEATURES = Object.freeze([
  { layer: "line", name: "Pacific route", points: [[-127, 31], [-118, 40], [-107, 34], [-96, 43], [-86, 37]] },
  { layer: "line", name: "Gulf route", points: [[-113, 24], [-101, 29], [-90, 27], [-80, 33]] },
  { layer: "polygon", name: "Edit polygon A", points: [[-118, 30], [-109, 45], [-91, 42], [-94, 27], [-111, 24], [-118, 30]] },
  { layer: "polygon", name: "Edit polygon B", points: [[-83, 24], [-73, 31], [-65, 25], [-72, 18], [-83, 24]] },
]);

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let lineLayerIndex = -1;
let polygonLayerIndex = -1;
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

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function beginEditing() {
  for (const index of [lineLayerIndex, polygonLayerIndex]) {
    if (index < 0) throw new Error("Editable layer is missing.");
    if (!viewer.isLayerEditing(index) && !viewer.beginEditLayer(index)) {
      throw new Error(`Layer ${index} could not enter edit mode.`);
    }
  }
  if (!viewer.setActiveEditLayerIndex(polygonLayerIndex)) {
    throw new Error("Editable Polygons layer could not be activated.");
  }
}

function updateInfo(message = "Edit Vertices tool is active.") {
  const selected = viewer.selectedFeatures()
    .filter((feature) => feature.layerIndex === lineLayerIndex || feature.layerIndex === polygonLayerIndex);
  const lines = [
    "Tool usage:",
    "- Edit Vertices: click a feature or one of its vertices.",
    "- Drag an active vertex to move it.",
    "- Double-click a selected segment to insert a vertex.",
    "- Press Delete or click Delete Vertex to remove the active vertex.",
    "",
    "Feature vertex counts:",
    ...FEATURES.map((feature) => `- ${feature.layer === "line" ? "Editable Lines" : "Editable Polygons"} / ${feature.name}: ${feature.points.length} vertices`),
    "",
    `Selected features: ${selected.length}`,
    ...selected.map((feature) => `- ${feature.layerName ?? "Layer"} / feature id ${feature.featureId}`),
  ];
  viewer.clearLog();
  viewer.appendLog(lines.join("\n"));
  viewer.setStatusText(`${message} Lines: 2 | Polygons: 2 | Selected: ${selected.length}`);
}

function populateShapes() {
  populating = true;
  try {
    for (const index of [lineLayerIndex, polygonLayerIndex]) {
      if (viewer.isLayerEditing(index) && !viewer.rollbackEditLayer(index)) {
        throw new Error(`Layer ${index} could not be reset.`);
      }
    }
    beginEditing();
    viewer.clearSelectedFeatures();
    for (const feature of FEATURES) {
      const layerIndex = feature.layer === "line" ? lineLayerIndex : polygonLayerIndex;
      const added = feature.layer === "line"
        ? viewer.addPolylineToEditLayer(layerIndex, feature.points, { Name: feature.name })
        : viewer.addPolygonToEditLayer(layerIndex, feature.points, { Name: feature.name });
      if (!added) throw new Error(`${feature.name} could not be added.`);
    }
  } finally {
    populating = false;
  }
  viewer.setTool(ViewerTool.EDIT_VERTICES);
  refreshMap();
  updateInfo("Shapes reset. Edit Vertices tool is active.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.PAN) {
    viewer.setTool(ViewerTool.PAN);
    updateInfo("Pan tool is active.");
  } else if (commandId === COMMAND.EDIT_VERTICES) {
    beginEditing();
    viewer.setTool(ViewerTool.EDIT_VERTICES);
    updateInfo("Edit Vertices tool is active.");
  } else if (commandId === COMMAND.DELETE_VERTEX) {
    const deleted = viewer.deleteSelectedVertexFromEditLayer();
    refreshMap();
    updateInfo(deleted ? "Selected vertex deleted." : "No active vertex to delete. Click a vertex first.");
  } else if (commandId === COMMAND.RESET) {
    populateShapes();
  } else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateInfo("Sample extent restored.");
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

function onViewerEvent(event) {
  if (populating) return;
  if (event.eventType !== ViewerEventType.SELECTION_CHANGED && event.eventType !== ViewerEventType.LAYER_EDIT_STATE_CHANGED) return;
  setImmediate(() => {
    if (!viewer || populating) return;
    updateInfo(event.eventType === ViewerEventType.SELECTION_CHANGED ? "Selection changed." : "Feature geometry updated.");
  });
}

function createEditableLayers() {
  lineLayerIndex = viewer.addEmptyVectorLayer("Editable Lines", ShapeType.POLYLINE, LINE_STYLE);
  polygonLayerIndex = viewer.addEmptyVectorLayer("Editable Polygons", ShapeType.POLYGON, POLYGON_STYLE);
  if (lineLayerIndex < 0 || polygonLayerIndex < 0) throw new Error("Editable layers could not be created.");
  lineLayerIndex = Number(viewer.layerInfoByName("Editable Lines")?.index ?? -1);
  polygonLayerIndex = Number(viewer.layerInfoByName("Editable Polygons")?.index ?? -1);
  if (lineLayerIndex < 0 || polygonLayerIndex < 0) throw new Error("Editable layer indices could not be resolved.");
  for (const index of [lineLayerIndex, polygonLayerIndex]) {
    if (!viewer.addLayerAttributeDefinition(index, "Name", AttributeType.STRING, 64, 0)) {
      throw new Error(`Name attribute could not be added to layer ${index}.`);
    }
  }
  beginEditing();
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
  viewer = new ViewerWindow({ title: "EditVerticesTool", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.EDIT_VERTICES, text: "Edit Vertices" },
    { id: COMMAND.DELETE_VERTEX, text: "Delete Vertex" },
    { id: COMMAND.RESET, text: "Reset Shapes" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLogPanel("Vertex editing");
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
  createEditableLayers();
  populateShapes();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateInfo("Edit Vertices: drag vertices, double-click segments to add, Delete to remove.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  lineLayerIndex = -1;
  polygonLayerIndex = -1;
  populating = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
