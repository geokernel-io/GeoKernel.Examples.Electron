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
const POINT_LAYER_NAME = "Points With Attributes";
const COMMAND = Object.freeze({ ADD_POINT: 1, INFO: 2, CLEAR: 3, FULL_EXTENT: 4 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
const POINT_STYLE = Object.freeze({
  pointColor: "#D95D39",
  lineColor: "#8C321D",
  pointSize: 9.5,
  lineWidth: 1.2,
  showLabels: true,
  labelField: "Name",
  labelFontSize: 10,
  labelColor: "#263238",
  labelHaloEnabled: true,
  labelHaloColor: "#FFFFFF",
  labelHaloWidth: 2,
  labelOffsetY: -11,
  labelAllowOverlap: true,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let pointLayerIndex = -1;
let pointCursor = 0;
let infoMode = false;
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

function pointCount() {
  return pointLayerIndex >= 0 ? viewer.layerFeatureCount(pointLayerIndex) : 0;
}

function updateStatus(message) {
  viewer.setStatusText(`${message} Feature count: ${pointCount()}`);
}

function samplePointAt(index) {
  const columns = 12;
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [-123 + column * 5, 29 + row * 4];
}

function activatePointEditing() {
  if (pointLayerIndex < 0) throw new Error(`${POINT_LAYER_NAME} layer is not in the viewer.`);
  if (!viewer.isLayerEditing(pointLayerIndex) && !viewer.beginEditLayer(pointLayerIndex)) {
    throw new Error(`${POINT_LAYER_NAME} layer could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(pointLayerIndex)) {
    throw new Error(`${POINT_LAYER_NAME} layer could not be activated for editing.`);
  }
}

function updateAttributesPanel(selectedFeatureId = -1) {
  const items = rows.length > 0
    ? rows.map((row) => ({
      shape: "none",
      label: `${row.featureNo === selectedFeatureId ? ">" : " "} ${row.featureNo}  |  ${row.Name}  |  ${row.Category}  |  ${row.Score}  |  ${row.Source}`,
    }))
    : [{ shape: "none", label: "#  |  Name  |  Category  |  Score  |  Source" }];
  viewer.setLegendItems(items);
}

function showInfo(message) {
  viewer.clearLog();
  viewer.appendLog(message);
}

function addPointWithAttributes() {
  activatePointEditing();
  const featureNo = pointCursor + 1;
  const [x, y] = samplePointAt(pointCursor);
  const attributes = {
    Name: `Site ${featureNo}`,
    Category: featureNo % 2 === 0 ? "Even" : "Odd",
    Score: featureNo * 10,
    Source: "JavaScript Object",
  };
  if (!viewer.addPointToEditLayer(pointLayerIndex, x, y, attributes)) {
    throw new Error("Point with attributes could not be added.");
  }
  pointCursor += 1;
  rows.push({ featureNo, ...attributes });
  infoMode = false;
  viewer.setTool(ViewerTool.PAN);
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateAttributesPanel();
  updateStatus(`addPointToEditLayer(${pointLayerIndex}, [${x.toFixed(4)}, ${y.toFixed(4)}], JavaScript Object attributes)`);
}

function activateInfo() {
  infoMode = true;
  viewer.setTool(ViewerTool.INFO);
  updateStatus("Info mode: click an added point to read its attributes.");
}

function clearPoints() {
  viewer.setTool(ViewerTool.PAN);
  infoMode = false;
  if (!viewer.rollbackEditLayer(pointLayerIndex)) throw new Error("Points with attributes could not be cleared.");
  activatePointEditing();
  pointCursor = 0;
  rows = [];
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  updateAttributesPanel();
  showInfo("Click Info, then click an added point to read its JavaScript Object attributes from the feature.");
  updateStatus("Points with attributes cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POINT) addPointWithAttributes();
  else if (commandId === COMMAND.INFO) activateInfo();
  else if (commandId === COMMAND.CLEAR) clearPoints();
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

function formatHit(hit) {
  if (!hit?.isValid || hit.layerIndex !== pointLayerIndex) return "No added point found.";
  const lines = [`Layer: ${hit.layerName}`, `Feature ID: ${hit.featureId}`, ""];
  for (const key of Object.keys(hit.attributes ?? {}).sort((a, b) => a.localeCompare(b))) {
    lines.push(`${key} = ${hit.attributes[key]}`);
  }
  return lines.join("\n");
}

function inspectPoint(event) {
  const hit = viewer.hitTestTopFeatureAt(event.screenRectangle.left, event.screenRectangle.top, 8);
  showInfo(formatHit(hit));
  updateAttributesPanel(hit?.isValid && hit.layerIndex === pointLayerIndex ? hit.featureId : -1);
  updateStatus(hit?.isValid && hit.layerIndex === pointLayerIndex
    ? `Attributes read from feature ${hit.featureId}.`
    : "No added point found under cursor.");
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    infoMode = event.intValue === ViewerTool.INFO;
    return;
  }
  if (event.eventType !== ViewerEventType.MAP_MOUSE_UP || !infoMode || event.intValue !== ViewerTool.INFO) return;
  setImmediate(() => {
    if (!viewer) return;
    try {
      inspectPoint(event);
    } catch (error) {
      viewer?.setStatusText(`Info failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function createAttributeLayer() {
  pointLayerIndex = viewer.addEmptyVectorLayer(POINT_LAYER_NAME, ShapeType.POINT, POINT_STYLE);
  if (pointLayerIndex < 0) throw new Error("Points With Attributes layer could not be created.");
  const definitions = [
    ["Name", AttributeType.STRING, 64],
    ["Category", AttributeType.STRING, 32],
    ["Score", AttributeType.INTEGER, 8],
    ["Source", AttributeType.STRING, 32],
  ];
  for (const [name, type, length] of definitions) {
    if (!viewer.addLayerAttributeDefinition(pointLayerIndex, name, type, length, 0)) {
      throw new Error(`Attribute definition '${name}' could not be added.`);
    }
  }
  activatePointEditing();
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
  viewer = new ViewerWindow({ title: "AddWithAttributes", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POINT, text: "Add Point With Attributes" },
    { id: COMMAND.INFO, text: "Info" },
    { id: COMMAND.CLEAR, text: "Clear Points" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLegendPanel("Added point attributes");
  viewer.setLegendWidth(430);
  viewer.addLogPanel("Info result");
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  updateAttributesPanel();
  showInfo("Click Info, then click an added point to read its JavaScript Object attributes from the feature.");
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
    createAttributeLayer();
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.refreshLayers();
    viewer.processEvents();
    updateStatus("Click Add Point to call addPointToEditLayer(index, worldPoint, attributes).");
  } catch (error) {
    viewer?.setStatusText("AddWithAttributes could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  pointLayerIndex = -1;
  pointCursor = 0;
  infoMode = false;
  rows = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
