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
const COMMAND = Object.freeze({ INFO: 1, PAN: 2, FULL_EXTENT: 3 });
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

function showEmptyInfo() {
  viewer.clearLog();
  viewer.appendLog("Property / Field     Value");
  viewer.appendLog("mapClicked           Click the map while ViewerTool.INFO is active.");
}

function showInfo(event, hit) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const worldPoint = viewer.screenToWorld(x, y);
  const attributes = hit.attributes ?? {};
  const rows = [
    ["Tool", "ViewerTool.INFO"],
    ["Signal", "MAP_MOUSE_UP"],
    ["Screen point", `(${Number(x).toFixed(1)}, ${Number(y).toFixed(1)})`],
    ["World point", worldPoint
      ? `(${Number(worldPoint.x).toFixed(6)}, ${Number(worldPoint.y).toFixed(6)})`
      : "-"],
    ["Layer", hit.layerName ?? hit.layer ?? "-"],
    ["Feature id", hit.featureId],
    ["Shape type", hit.shapeType ?? hit.type ?? "-"],
    ["Extent", extentText(hit.extent)],
  ];
  for (const key of Object.keys(attributes).sort((left, right) => left.localeCompare(right))) {
    rows.push([key, attributes[key]]);
  }
  viewer.clearLog();
  viewer.appendLog("Property / Field     Value");
  for (const [field, value] of rows) {
    viewer.appendLog(`${String(field).padEnd(20)} ${valueText(value)}`);
  }
}

function activateInfo() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  viewer.setStatusText("ViewerTool.INFO active. Click the map to receive MAP_MOUSE_UP.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.INFO) activateInfo();
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
    const worldPoint = viewer.screenToWorld(x, y);
    viewer.clearLog();
    viewer.appendLog("Property / Field     Value");
    viewer.appendLog("Tool                 ViewerTool.INFO");
    viewer.appendLog("Signal               MAP_MOUSE_UP");
    viewer.appendLog(`Screen point         (${Number(x).toFixed(1)}, ${Number(y).toFixed(1)})`);
    viewer.appendLog(worldPoint
      ? `World point          (${Number(worldPoint.x).toFixed(6)}, ${Number(worldPoint.y).toFixed(6)})`
      : "World point          -");
    viewer.setStatusText("MAP_MOUSE_UP received, no feature hit.");
    return;
  }
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  const tolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  viewer.clearSelectedFeatures();
  viewer.selectFeatureHit(hit, tolerance);
  showInfo(event, hit);
  viewer.setStatusText(
    `MAP_MOUSE_UP with ViewerTool.INFO: ${hit.layerName ?? "-"} feature ${hit.featureId}`
  );
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
  } else if (event.eventType === ViewerEventType.MAP_MOUSE_UP && currentTool === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { inspectFeature(event); }
      catch (error) {
        viewer?.setStatusText(`Info tool failed: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "InfoTool", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.INFO, text: "Info Tool" },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("Info tool click details");
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
  showEmptyInfo();
  activateInfo();
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
