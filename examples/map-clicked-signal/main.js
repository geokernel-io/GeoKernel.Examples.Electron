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
const SHIFT_MODIFIER = 0x02000000;
const CONTROL_MODIFIER = 0x04000000;
const ALT_MODIFIER = 0x08000000;
const META_MODIFIER = 0x10000000;
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
let clickSequence = 0;

function toolName(tool) {
  const names = new Map([
    [ViewerTool.PAN, "Pan"],
    [ViewerTool.ZOOM_BOX, "ZoomBox"],
    [ViewerTool.INFO, "Info"],
    [ViewerTool.SELECT, "Select"],
    [ViewerTool.ADD_POINT, "AddPoint"],
    [ViewerTool.ADD_POLYLINE, "AddPolyline"],
    [ViewerTool.ADD_POLYGON, "AddPolygon"],
    [ViewerTool.MOVE_FEATURE, "MoveFeature"],
    [ViewerTool.ROUTE, "Route"],
    [ViewerTool.EDIT_VERTICES, "EditVertices"],
  ]);
  return names.get(tool) ?? "Unknown";
}

function modifiersText(modifiers) {
  const parts = [];
  if ((modifiers & SHIFT_MODIFIER) !== 0) parts.push("Shift");
  if ((modifiers & CONTROL_MODIFIER) !== 0) parts.push("Ctrl");
  if ((modifiers & ALT_MODIFIER) !== 0) parts.push("Alt");
  if ((modifiers & META_MODIFIER) !== 0) parts.push("Meta");
  return parts.length > 0 ? parts.join("+") : "-";
}

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

function activateInfo() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  viewer.setStatusText("Info tool active. Click to emit MAP_MOUSE_UP.");
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

function logMapClick(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const tool = Number.isInteger(event.intValue) ? event.intValue : currentTool;
  const modifiers = Math.trunc(event.doubleValue ?? 0);
  const worldPoint = viewer.screenToWorld(x, y);
  const hit = viewer.hitTestTopFeatureAt(x, y, 8);
  clickSequence += 1;
  const timestamp = new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const screenText = `(${Number(x).toFixed(1)}, ${Number(y).toFixed(1)})`;
  const worldText = worldPoint
    ? `(${Number(worldPoint.x).toFixed(6)}, ${Number(worldPoint.y).toFixed(6)})`
    : "-";
  const layer = hit?.isValid ? (hit.layerName ?? hit.layer ?? "-") : "-";
  const featureId = hit?.isValid ? hit.featureId : "-";
  const shapeType = hit?.isValid ? (hit.shapeType ?? hit.type ?? "-") : "-";
  viewer.appendLog(
    `${String(clickSequence).padStart(3)} | ${timestamp} | ${toolName(tool)} | ${screenText} | ${worldText} | ${modifiersText(modifiers)} | ${layer} | ${featureId} | ${shapeType}`
  );

  if (hit?.isValid) {
    const worldLeft = viewer.screenToWorld(x - 8, y);
    const worldRight = viewer.screenToWorld(x + 8, y);
    const tolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
    viewer.clearSelectedFeatures();
    viewer.selectFeatureHit(hit, tolerance);
  } else {
    viewer.clearSelectedFeatures();
  }
  viewer.setStatusText(
    `MAP_MOUSE_UP: tool=${toolName(tool)} screen=${screenText} world=${worldText} modifiers=${modifiersText(modifiers)}`
  );
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
  } else if (event.eventType === ViewerEventType.MAP_MOUSE_UP) {
    setImmediate(() => {
      if (!viewer) return;
      try { logMapClick(event); }
      catch (error) {
        viewer?.setStatusText(`MAP_MOUSE_UP handling failed: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "MapClickedSignal", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.INFO, text: "Info" },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("MAP_MOUSE_UP signal log");
  viewer.setTool(ViewerTool.INFO);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing sample data...");
  viewer.appendLog("#   | Time         | Tool | Screen point | World point | Modifiers | Hit layer | Feature ID | Shape type");
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
  activateInfo();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  currentTool = ViewerTool.INFO;
  clickSequence = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };



