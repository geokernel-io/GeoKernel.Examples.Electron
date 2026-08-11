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
const LAYER_NAME = "Movable Points";
const COMMAND = Object.freeze({ SELECT: 1, MOVE: 2, RESET: 3, FULL_EXTENT: 4 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({
  pointColor: "#D95D39",
  lineColor: "#8C321D",
  pointSize: 12,
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
  labelOffsetY: -13,
  labelAllowOverlap: true,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let currentTool = ViewerTool.PAN;
let populating = false;
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
  return [-121 + (index % 7) * 8, 31 + Math.floor(index / 7) * 5.5];
}

function selectedPointFeatures() {
  return viewer.selectedFeatures().filter((feature) => feature.layerIndex === pointLayerIndex);
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Feature count: ${rows.length} | Selected: ${selectedPointFeatures().length}`);
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

function selectedIds() {
  return new Set(selectedPointFeatures().map((feature) => feature.shapeId));
}

function synchronizeMovedCoordinates() {
  for (const feature of selectedPointFeatures()) {
    const row = rows.find((candidate) => candidate.shapeId === feature.shapeId);
    if (!row || !feature.extent) continue;
    row.x = feature.extent.xMin;
    row.y = feature.extent.yMin;
  }
}

function updateFeaturePanel() {
  synchronizeMovedCoordinates();
  const selected = selectedIds();
  const items = rows.length > 0
    ? rows.map((row) => ({
      shape: "none",
      label: `${selected.has(row.shapeId) ? ">" : " "} ${row.shapeId}  |  ${row.Name}  |  ${row.Group}  |  ${row.x.toFixed(3)}, ${row.y.toFixed(3)}`,
    }))
    : [{ shape: "none", label: "Feature ID  |  Name  |  Group  |  X, Y" }];
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
  if (pointLayerIndex < 0) return;
  populating = true;
  try {
    if (viewer.isLayerEditing(pointLayerIndex) && !viewer.rollbackEditLayer(pointLayerIndex)) {
      throw new Error("Movable points could not be reset.");
    }
    activateEditing();
    viewer.clearSelectedFeatures();
    rows = [];
    for (let index = 0; index < 14; index += 1) {
      const shapeId = index + 1;
      const [x, y] = samplePointAt(index);
      const attributes = {
        Name: `Point ${shapeId}`,
        Group: index % 2 === 0 ? "North" : "South",
      };
      if (!viewer.addPointToEditLayer(pointLayerIndex, x, y, attributes)) {
        throw new Error(`Point ${shapeId} could not be added.`);
      }
      rows.push({ shapeId, x, y, ...attributes });
    }
  } finally {
    populating = false;
  }
  refreshMap();
  updateFeaturePanel();
  showSelection("Select mode: click a point. Move Feature mode: drag the selected point.");
  updateStatus("Points reset.");
}

function activateSelect() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  updateStatus("Select mode: click a point.");
}

function activateMove() {
  activateEditing();
  if (selectedPointFeatures().length === 0) {
    activateSelect();
    updateStatus("Select a point before activating Move Feature.");
    return;
  }
  currentTool = ViewerTool.MOVE_FEATURE;
  viewer.setTool(ViewerTool.MOVE_FEATURE);
  updateStatus("Move Feature mode: drag the selected point.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SELECT) activateSelect();
  else if (commandId === COMMAND.MOVE) activateMove();
  else if (commandId === COMMAND.RESET) {
    populatePoints();
    activateSelect();
  } else if (commandId === COMMAND.FULL_EXTENT) {
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
  const hit = viewer.hitTestFeaturesAt(x, y, 8)
    .find((feature) => feature.isValid && feature.layerIndex === pointLayerIndex);
  if (!hit?.isValid || hit.layerIndex !== pointLayerIndex) {
    viewer.clearSelectedFeatures();
    updateFeaturePanel();
    showSelection("No movable point feature found.");
    updateStatus("No movable point feature found.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const worldTolerance = worldLeft && worldRight
    ? Math.abs(worldRight.x - worldLeft.x) / 2
    : 1;
  viewer.clearSelectedFeatures();
  if (!viewer.selectFeatureHit(hit, worldTolerance)) {
    throw new Error("Movable point could not be selected.");
  }
  const selected = selectedPointFeatures();
  updateFeaturePanel();
  const lines = [
    `Selected feature count: ${selected.length}`,
    "Move Feature tool: drag a selected point to a new location.",
  ];
  for (const feature of selected) lines.push(`Feature ${feature.featureId}: ${feature.attributes?.Name ?? "-"}`);
  showSelection(lines.join("\n"));
  updateStatus(`Selected feature ${hit.featureId}.`);
}

function handleGeometryChange() {
  synchronizeMovedCoordinates();
  updateFeaturePanel();
  const selected = selectedPointFeatures();
  const lines = [
    `Selected feature count: ${selected.length}`,
    "Feature geometry changed by Move Feature tool.",
  ];
  for (const feature of selected) lines.push(`Feature ${feature.featureId}: ${feature.attributes?.Name ?? "-"}`);
  showSelection(lines.join("\n"));
  refreshMap();
  updateStatus("Feature geometry changed by Move Feature tool.");
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
    return;
  }
  if (event.eventType === ViewerEventType.SELECTION_CHANGED) {
    setImmediate(() => {
      if (!viewer) return;
      updateFeaturePanel();
    });
    return;
  }
  if (event.eventType === ViewerEventType.LAYER_EDIT_STATE_CHANGED && event.intValue === pointLayerIndex && !populating) {
    setImmediate(() => {
      if (!viewer) return;
      try {
        handleGeometryChange();
      } catch (error) {
        viewer?.setStatusText(`Move refresh failed: ${error.message}`);
      }
    });
    return;
  }
  if (event.eventType !== ViewerEventType.MAP_MOUSE_UP || currentTool !== ViewerTool.INFO || event.intValue !== ViewerTool.INFO) return;
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

function createMovableLayer() {
  pointLayerIndex = viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POINT, POINT_STYLE);
  if (pointLayerIndex < 0) throw new Error("Movable Points layer could not be created.");
  const definitions = [
    ["Name", AttributeType.STRING, 64],
    ["Group", AttributeType.STRING, 32],
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
  viewer = new ViewerWindow({ title: "MoveFeatureTool", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.MOVE, text: "Move Feature" },
    { id: COMMAND.RESET, text: "Reset Points" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLegendPanel("Movable point features");
  viewer.setLegendWidth(440);
  viewer.addLogPanel("Selection");
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  updateFeaturePanel();
  showSelection("Select mode: click a point. Move Feature mode: drag the selected point.");
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
    createMovableLayer();
    populatePoints();
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    activateSelect();
    updateStatus("Select a point, switch to Move Feature, then drag it on the map.");
  } catch (error) {
    viewer?.setStatusText("MoveFeatureTool could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  currentTool = ViewerTool.PAN;
  populating = false;
  rows = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
