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
const COMMAND = Object.freeze({ SELECT: 1, RESET: 2, FULL_EXTENT: 3 });
const CONTROL = Object.freeze({ DELTA: 1, WEST: 2, EAST: 3, NORTH: 4, SOUTH: 5 });
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
let selectMode = false;
let delta = 3;
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

function updateFeaturePanel() {
  const selectedIds = new Set(selectedPointFeatures().map((feature) => feature.shapeId));
  const items = rows.length > 0
    ? rows.map((row) => ({
      shape: "none",
      label: `${selectedIds.has(row.shapeId) ? ">" : " "} ${row.shapeId}  |  ${row.Name}  |  ${row.Group}  |  ${row.x.toFixed(3)}, ${row.y.toFixed(3)}`,
    }))
    : [{ shape: "none", label: "Feature ID  |  Name  |  Group  |  X, Y" }];
  viewer.setLegendItems(items);
}

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function populatePoints() {
  if (pointLayerIndex < 0) return;
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
  refreshMap();
  updateFeaturePanel();
  updateStatus("Points reset. Select a point, then use a direction button.");
}

function activateSelect() {
  selectMode = true;
  viewer.setTool(ViewerTool.INFO);
  updateStatus("Select mode: click a movable point.");
}

function selectAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const hit = viewer.hitTestFeaturesAt(x, y, 8)
    .find((feature) => feature.isValid && feature.layerIndex === pointLayerIndex);
  if (!hit) {
    viewer.clearSelectedFeatures();
    updateFeaturePanel();
    updateStatus("No movable point feature found.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const worldTolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  viewer.clearSelectedFeatures();
  if (!viewer.selectFeatureHit(hit, worldTolerance)) {
    throw new Error("Movable point could not be selected.");
  }
  updateFeaturePanel();
  updateStatus(`Selected feature ${hit.featureId}: ${hit.attributes?.Name ?? "-"}.`);
}

function moveSelection(deltaX, deltaY) {
  activateEditing();
  const selected = selectedPointFeatures();
  if (selected.length === 0) {
    updateStatus("Select one or more movable points first.");
    return;
  }
  if (!viewer.canMoveSelectedFeatures()) {
    updateStatus("Current selection cannot be moved.");
    return;
  }
  if (!viewer.moveSelectedFeaturesInEditLayer(deltaX, deltaY)) {
    throw new Error("moveSelectedFeaturesInEditLayer failed.");
  }
  const selectedIds = new Set(selected.map((feature) => feature.shapeId));
  for (const row of rows) {
    if (!selectedIds.has(row.shapeId)) continue;
    row.x += deltaX;
    row.y += deltaY;
  }
  refreshMap();
  updateFeaturePanel();
  updateStatus(`moveSelectedFeaturesInEditLayer(${deltaX.toFixed(2)}, ${deltaY.toFixed(2)})`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SELECT) activateSelect();
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

function handleControl(controlId, numericValue) {
  if (controlId === CONTROL.DELTA) {
    delta = Math.min(30, Math.max(0.1, numericValue));
    updateStatus(`Movement delta set to ${delta.toFixed(2)} degrees.`);
  } else if (controlId === CONTROL.WEST) moveSelection(-delta, 0);
  else if (controlId === CONTROL.EAST) moveSelection(delta, 0);
  else if (controlId === CONTROL.NORTH) moveSelection(0, delta);
  else if (controlId === CONTROL.SOUTH) moveSelection(0, -delta);
}

function onControl(controlId, numericValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleControl(controlId, numericValue);
    } catch (error) {
      viewer?.setStatusText(`Move failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    selectMode = event.intValue === ViewerTool.INFO;
    return;
  }
  if (event.eventType === ViewerEventType.SELECTION_CHANGED) {
    setImmediate(() => {
      if (viewer) updateFeaturePanel();
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
  viewer = new ViewerWindow({ title: "MoveFeatureProgrammatic", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.RESET, text: "Reset Points" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLegendPanel("Movable point features");
  viewer.setLegendWidth(440);
  viewer.addControlPanel({
    title: "Programmatic movement",
    area: "right",
    width: 230,
    controls: [
      { id: CONTROL.DELTA, type: "number", label: "Delta (deg)", minimum: 0.1, maximum: 30, decimals: 2, step: 0.5, value: 3 },
      { id: CONTROL.WEST, type: "button", text: "Move West" },
      { id: CONTROL.EAST, type: "button", text: "Move East" },
      { id: CONTROL.NORTH, type: "button", text: "Move North" },
      { id: CONTROL.SOUTH, type: "button", text: "Move South" },
    ],
  }, onControl);
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  updateFeaturePanel();
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
    updateStatus("Select one or more points, then move them with direction buttons.");
  } catch (error) {
    viewer?.setStatusText("MoveFeatureProgrammatic could not be initialized.");
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
  delta = 3;
  rows = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
