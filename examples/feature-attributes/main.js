"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_BASE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/";
const SAMPLE_EXTENT = extent(-130, 22, -65, 55);
const COMMAND = Object.freeze({ ATTRIBUTES: 1, PAN: 2, FULL_EXTENT: 3 });
const WORLD_STYLE = Object.freeze({
  fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#708984", lineWidth: 0.6,
  selectedLineColor: "#F59E0B", selectedLineWidth: 3,
});
const STATE_STYLE = Object.freeze({
  fillColor: "#C7DEE7", fillOpacity: 160, lineColor: "#2D6F8E", lineWidth: 1,
  selectedLineColor: "#F59E0B", selectedLineWidth: 4,
});
const CITY_STYLE = Object.freeze({
  pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 8, lineWidth: 1,
  selectedPointColor: "#F59E0B", selectedLineColor: "#F59E0B", selectedLineWidth: 4,
  showLabels: true, labelField: "NAME", labelFontSize: 9, labelColor: "#263238",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let currentTool = ViewerTool.INFO;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll")
      : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function extentText(value) {
  if (!value) return "-";
  const fixed = (number) => Number(number).toFixed(6);
  return `(${fixed(value.xMin)}, ${fixed(value.yMin)}) - (${fixed(value.xMax)}, ${fixed(value.yMax)})`;
}

function valueText(value) {
  if (value === null || value === undefined) return "<null>";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function showEmptyAttributes() {
  viewer.clearLog();
  viewer.appendLog("Field                Value");
  viewer.appendLog("Attributes           Click a feature to read FeatureHitTestResult::attributes().");
}

function showAttributes(hit) {
  const attributes = hit.attributes ?? {};
  const rows = [
    ["Layer", hit.layerName ?? hit.layer ?? "-"],
    ["Layer index", hit.layerIndex],
    ["Feature id", hit.featureId],
    ["Shape type", hit.shapeType ?? hit.type ?? "-"],
    ["Extent", extentText(hit.extent)],
    ["attributes().count", Object.keys(attributes).length],
  ];
  for (const key of Object.keys(attributes).sort((left, right) => left.localeCompare(right))) {
    rows.push([key, attributes[key]]);
  }
  viewer.clearLog();
  viewer.appendLog("Field                Value");
  for (const [field, value] of rows) {
    viewer.appendLog(`${String(field).padEnd(20)} ${valueText(value)}`);
  }
}

function activateAttributes() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  viewer.setStatusText("Click a feature to read all attribute values.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ATTRIBUTES) activateAttributes();
  else if (commandId === COMMAND.PAN) {
    currentTool = ViewerTool.PAN;
    viewer.setTool(ViewerTool.PAN);
    viewer.setStatusText("Pan mode.");
  } else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.setStatusText("Sample extent restored.");
  }
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    try { handleCommand(commandId); }
    catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function inspectFeature(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const hit = viewer.hitTestTopFeatureAt(x, y, 8);
  if (!hit?.isValid) {
    viewer.clearSelectedFeatures();
    showEmptyAttributes();
    viewer.setStatusText("No feature hit.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const tolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  viewer.clearSelectedFeatures();
  viewer.selectFeatureHit(hit, tolerance);
  showAttributes(hit);
  const count = Object.keys(hit.attributes ?? {}).length;
  viewer.setStatusText(`attributes() returned ${count} field(s) for ${hit.layerName ?? "-"} feature ${hit.featureId}.`);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
  } else if (event.eventType === ViewerEventType.MAP_MOUSE_UP && currentTool === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { inspectFeature(event); }
      catch (error) {
        viewer?.setStatusText(`Attribute read failed: ${error.message}`);
        console.error(error?.stack || error);
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
  keeperWindow = new BrowserWindow({
    width: 1, height: 1, show: false, skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({ title: "FeatureAttributes", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ATTRIBUTES, text: "Feature Attributes" },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
    { id: 99, text: "API: FeatureHitTestResult::attributes()", enabled: false, separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("Attributes");
  viewer.setTool(ViewerTool.INFO);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const [worldPath, statesPath, citiesPath] = await Promise.all([
    ensureSampleFile(`${SAMPLE_BASE_URL}world_4326.zip`, "world_4326.zip", "world_4326", "world_4326.shp"),
    ensureSampleFile(`${SAMPLE_BASE_URL}usa_states.zip`, "usa_states.zip", "usa_states", "usa_states.shp"),
    ensureSampleFile(`${SAMPLE_BASE_URL}cities_4326.zip`, "cities_4326.zip", "cities_4326", "cities_4326.shp"),
  ]);
  if (!viewer) return;

  for (const [layerPath, name, style] of [
    [worldPath, "World", WORLD_STYLE],
    [statesPath, "USA States", STATE_STYLE],
    [citiesPath, "Cities", CITY_STYLE],
  ]) {
    viewer.addLayer(layerPath, { buildFeatureSource: true });
    viewer.setLayerName(0, name);
    viewer.setLayerStyle(0, style);
  }
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  showEmptyAttributes();
  activateAttributes();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  currentTool = ViewerTool.INFO;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
