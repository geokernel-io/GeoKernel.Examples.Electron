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
const LAYER_NAME = "Capability Points";
const COMMAND = Object.freeze({ BEGIN_EDIT: 1, COMMIT: 2, ROLLBACK: 3, SELECT: 4, CLEAR: 5, RESET: 6, FULL_EXTENT: 7 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({
  pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 11, lineWidth: 1.2,
  selectedPointColor: "#F59E0B", selectedLineColor: "#F59E0B", selectedLineWidth: 4,
  showLabels: true, labelField: "Name", labelFontSize: 10, labelColor: "#263238",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
  labelOffsetY: -12, labelAllowOverlap: true,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let currentTool = ViewerTool.PAN;
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

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function updateFeaturePanel() {
  const selectedIds = new Set(selectedPointFeatures().map((feature) => feature.shapeId));
  viewer.setLegendItems(rows.map((row) => ({
    shape: "point",
    color: selectedIds.has(row.shapeId) ? "#F59E0B" : "#D95D39",
    label: `${row.shapeId}  |  ${row.Name}  |  ${row.Group}`,
  })));
}

function updateSelectionPanel() {
  const selected = selectedPointFeatures();
  viewer.clearLog();
  viewer.appendLog("Can edit checks");
  viewer.appendLog(`canEditLayer(index): ${viewer.canEditLayer(pointLayerIndex) ? "true" : "false"}`);
  viewer.appendLog(`canEditSelectedFeatures(): ${viewer.canEditSelectedFeatures() ? "true" : "false"}`);
  viewer.appendLog(`canMoveSelectedFeatures(): ${viewer.canMoveSelectedFeatures() ? "true" : "false"}\n`);
  if (selected.length === 0) {
    viewer.appendLog("No selected feature.\n\ncanEditSelectedFeatures and canMoveSelectedFeatures require at least one selected feature.");
    return;
  }
  viewer.appendLog(`Selected feature count: ${selected.length}`);
  for (const feature of selected) {
    viewer.appendLog(`Feature ${feature.featureId}: ${feature.attributes?.Name ?? "-"}`);
  }
  viewer.appendLog("\nSelect another point to replace the current selection.");
}

function updateChecks(message) {
  if (!viewer || pointLayerIndex < 0) return;
  const editing = viewer.isLayerEditing(pointLayerIndex);
  const selectedCount = selectedPointFeatures().length;
  updateSelectionPanel();
  viewer.setStatusText(`${message} Layer index: ${pointLayerIndex} | Editing: ${editing ? "ON" : "OFF"} | Selected: ${selectedCount}`);
}

function activateEditing() {
  if (pointLayerIndex < 0) throw new Error(`${LAYER_NAME} layer is missing.`);
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error(`${LAYER_NAME} layer could not become the active edit layer.`);
  }
}

function populatePoints() {
  if (viewer.isLayerEditing(pointLayerIndex) && !viewer.rollbackEditLayer(pointLayerIndex)) {
    throw new Error("Existing point edits could not be rolled back.");
  }
  activateEditing();
  viewer.clearSelectedFeatures();
  rows = [];
  for (let index = 0; index < 14; index += 1) {
    const shapeId = index + 1;
    const [x, y] = samplePointAt(index);
    const attributes = { Name: `Point ${shapeId}`, Group: index % 2 === 0 ? "North" : "South" };
    if (!viewer.addPointToEditLayer(pointLayerIndex, x, y, attributes)) {
      throw new Error(`Point ${shapeId} could not be added.`);
    }
    rows.push({ shapeId, ...attributes });
  }
  if (!viewer.commitEditLayer(pointLayerIndex)) throw new Error("Initial points could not be committed.");
  currentTool = ViewerTool.PAN;
  viewer.setTool(ViewerTool.PAN);
  refreshMap();
  updateFeaturePanel();
  updateSelectionPanel();
  updateChecks("Points reset. Click Begin Edit, then Select.");
}

function beginEdit() {
  if (viewer.isLayerEditing(pointLayerIndex)) {
    updateChecks("Edit session is already active.");
    return;
  }
  activateEditing();
  updateChecks("Edit session started. Click Select, then click a point.");
}

function commitEdit() {
  if (!viewer.isLayerEditing(pointLayerIndex)) {
    updateChecks("No active edit session to commit.");
    return;
  }
  if (!viewer.commitEditLayer(pointLayerIndex)) throw new Error("Edit session could not be committed.");
  updateChecks("Edit session committed. Selection checks are false until editing starts again.");
}

function rollbackEdit() {
  if (!viewer.isLayerEditing(pointLayerIndex)) {
    updateChecks("No active edit session to roll back.");
    return;
  }
  if (!viewer.rollbackEditLayer(pointLayerIndex)) throw new Error("Edit session could not be rolled back.");
  viewer.clearSelectedFeatures();
  refreshMap();
  updateFeaturePanel();
  updateSelectionPanel();
  updateChecks("Edit session rolled back.");
}

function activateSelect() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  updateChecks("Select mode is active. Click one of the editable points.");
}

function clearSelection() {
  viewer.clearSelectedFeatures();
  updateFeaturePanel();
  updateSelectionPanel();
  updateChecks("Selection cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.BEGIN_EDIT) beginEdit();
  else if (commandId === COMMAND.COMMIT) commitEdit();
  else if (commandId === COMMAND.ROLLBACK) rollbackEdit();
  else if (commandId === COMMAND.SELECT) activateSelect();
  else if (commandId === COMMAND.CLEAR) clearSelection();
  else if (commandId === COMMAND.RESET) populatePoints();
  else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateChecks("Sample extent restored.");
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

function selectAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const hit = viewer.hitTestFeaturesAt(x, y, 8)
    .find((feature) => feature.isValid && feature.layerIndex === pointLayerIndex);
  if (!hit) {
    clearSelection();
    updateChecks("No editable point was found at the clicked position.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const worldTolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  viewer.clearSelectedFeatures();
  if (!viewer.selectFeatureHit(hit, worldTolerance)) throw new Error("The editable point could not be selected.");
  updateFeaturePanel();
  updateSelectionPanel();
  updateChecks(`Feature ${hit.featureId} selected.`);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
    return;
  }
  if (event.eventType === ViewerEventType.MAP_MOUSE_UP && currentTool === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { selectAt(event); } catch (error) {
        viewer?.setStatusText(`Selection failed: ${error.message}`);
      }
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
  viewer = new ViewerWindow({ title: "CanEditCheck", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.BEGIN_EDIT, text: "Begin Edit" },
    { id: COMMAND.COMMIT, text: "Commit Edit" },
    { id: COMMAND.ROLLBACK, text: "Rollback Edit" },
    { id: COMMAND.SELECT, text: "Select", separatorBefore: true },
    { id: COMMAND.CLEAR, text: "Clear Selection" },
    { id: COMMAND.RESET, text: "Reset Points", separatorBefore: true },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLegendPanel("Editable features");
  viewer.addLogPanel("Capability checks and selection");
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POINT, POINT_STYLE);
  pointLayerIndex = Number(viewer.layerInfoByName(LAYER_NAME)?.index ?? -1);
  if (pointLayerIndex < 0) throw new Error(`${LAYER_NAME} layer could not be created.`);
  for (const [name, length] of [["Name", 64], ["Group", 32]]) {
    if (!viewer.addLayerAttributeDefinition(pointLayerIndex, name, AttributeType.STRING, length, 0)) {
      throw new Error(`${name} attribute definition could not be added.`);
    }
  }
  populatePoints();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateChecks("Use Begin Edit and Select to see canEdit* capability checks change.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  currentTool = ViewerTool.PAN;
  rows = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
