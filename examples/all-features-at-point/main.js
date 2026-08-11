"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_BASE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/";
const SAMPLE_EXTENT = extent(-130, 22, -65, 55);
const COMMAND = Object.freeze({ IDENTIFY: 1, PAN: 2, PREVIOUS: 3, NEXT: 4, FULL_EXTENT: 5 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#708984", lineWidth: 0.6, selectedLineColor: "#F59E0B", selectedLineWidth: 3 });
const STATE_STYLE = Object.freeze({ fillColor: "#C7DEE7", fillOpacity: 160, lineColor: "#2D6F8E", lineWidth: 1, selectedLineColor: "#F59E0B", selectedLineWidth: 4 });
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
let currentHits = [];
let currentHitIndex = -1;
let currentWorldTolerance = 1;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
}

function valueText(value) {
  if (value === null || value === undefined) return "<null>";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function extentText(value) {
  if (!value) return "-";
  return `(${Number(value.xMin).toFixed(6)}, ${Number(value.yMin).toFixed(6)}) - (${Number(value.xMax).toFixed(6)}, ${Number(value.yMax).toFixed(6)})`;
}

function bestDisplayName(hit) {
  const attributes = hit.attributes ?? {};
  for (const key of ["NAME", "Name", "STATE", "STATE_NAME", "COUNTRY", "ADMIN"]) {
    if (String(attributes[key] ?? "").trim()) return String(attributes[key]);
  }
  return `Feature ${hit.featureId}`;
}

function updateHitsPanel() {
  const items = currentHits.length > 0
    ? currentHits.map((hit, index) => ({
      shape: "none",
      label: `${index === currentHitIndex ? ">" : " "} ${index + 1} | ${hit.layerName ?? hit.layer ?? "-"} | ${hit.featureId} | ${hit.shapeType ?? hit.type ?? "-"} | ${bestDisplayName(hit)}`,
    }))
    : [{ shape: "none", label: "No hits" }];
  viewer.setLegendItems(items);
}

function showEmptyDetails(message) {
  viewer.clearLog();
  viewer.appendLog(`Info                 ${message}`);
}

function showDetails(hit) {
  viewer.clearLog();
  const rows = [
    ["Layer", hit.layerName ?? hit.layer ?? "-"],
    ["Layer index", hit.layerIndex],
    ["Shape id", hit.shapeId],
    ["Feature id", hit.featureId],
    ["Shape type", hit.shapeType ?? hit.type ?? "-"],
    ["Provider feature", hit.isProviderFeature],
    ["World point", hit.worldPoint ? `${Number(hit.worldPoint.x).toFixed(6)}, ${Number(hit.worldPoint.y).toFixed(6)}` : "-"],
    ["Extent", extentText(hit.extent)],
  ];
  for (const key of Object.keys(hit.attributes ?? {}).sort((left, right) => left.localeCompare(right))) rows.push([key, hit.attributes[key]]);
  viewer.appendLog("Property / Field     Value");
  for (const [name, value] of rows) viewer.appendLog(`${String(name).padEnd(20)} ${valueText(value)}`);
}

function selectCurrentHit() {
  if (currentHitIndex < 0 || currentHitIndex >= currentHits.length) return;
  const hit = currentHits[currentHitIndex];
  viewer.clearSelectedFeatures();
  viewer.selectFeatureHit(hit, currentWorldTolerance);
  updateHitsPanel();
  showDetails(hit);
  viewer.setStatusText(`Selected hit ${currentHitIndex + 1}/${currentHits.length}: ${hit.layerName ?? hit.layer ?? "-"} feature ${hit.featureId}.`);
}

function activateIdentify() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  viewer.setStatusText("Tool: hitTestFeaturesAt. Click a point to list all feature hits.");
}

function activatePan() {
  currentTool = ViewerTool.PAN;
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Tool: Pan.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.IDENTIFY) activateIdentify();
  else if (commandId === COMMAND.PAN) activatePan();
  else if (commandId === COMMAND.PREVIOUS && currentHits.length > 0) {
    currentHitIndex = (currentHitIndex - 1 + currentHits.length) % currentHits.length;
    selectCurrentHit();
  } else if (commandId === COMMAND.NEXT && currentHits.length > 0) {
    currentHitIndex = (currentHitIndex + 1) % currentHits.length;
    selectCurrentHit();
  } else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.setStatusText("Sample extent restored.");
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

function inspectAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  currentHits = viewer.hitTestFeaturesAt(x, y, 8).filter((hit) => hit?.isValid);
  const worldLeft = viewer.screenToWorld(x - 8, y);
  const worldRight = viewer.screenToWorld(x + 8, y);
  currentWorldTolerance = worldLeft && worldRight ? Math.abs(worldRight.x - worldLeft.x) / 2 : 1;
  currentHitIndex = currentHits.length > 0 ? 0 : -1;
  if (currentHits.length === 0) {
    viewer.clearSelectedFeatures();
    updateHitsPanel();
    showEmptyDetails("No feature at clicked point.");
    viewer.setStatusText("No feature hit at the clicked point.");
    return;
  }
  selectCurrentHit();
  viewer.setStatusText(`${currentHits.length} feature hit(s) at the clicked point. Use Previous Hit / Next Hit to inspect each result.`);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
    return;
  }
  if (event.eventType === ViewerEventType.MAP_MOUSE_UP && currentTool === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { inspectAt(event); } catch (error) {
        viewer?.setStatusText(`Hit test failed: ${error.message}`);
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
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "AllFeaturesAtPoint", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.IDENTIFY, text: "All Features Here" },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.PREVIOUS, text: "Previous Hit", separatorBefore: true },
    { id: COMMAND.NEXT, text: "Next Hit" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLegendPanel("Features at clicked point");
  viewer.setLegendWidth(360);
  viewer.addLogPanel("Selected hit details");
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
  for (const [layerPath, name, style] of [[worldPath, "World", WORLD_STYLE], [statesPath, "USA States", STATE_STYLE], [citiesPath, "Cities", CITY_STYLE]]) {
    viewer.addLayer(layerPath, { buildFeatureSource: true });
    viewer.setLayerName(0, name);
    viewer.setLayerStyle(0, style);
  }
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateHitsPanel();
  showEmptyDetails("Click the map to inspect all feature hits.");
  activateIdentify();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  currentTool = ViewerTool.INFO;
  currentHits = [];
  currentHitIndex = -1;
  currentWorldTolerance = 1;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
