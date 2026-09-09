"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_BASE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/";
const SAMPLE_EXTENT = extent(-130, 22, -65, 55);
const COMMAND = Object.freeze({ SELECT: 1, PAN: 2, CLEAR: 3, PREVIOUS: 4, NEXT: 5, FULL_EXTENT: 6 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#708984", lineWidth: 0.6, selectedLineColor: "#F59E0B", selectedLineWidth: 3 });
const STATE_STYLE = Object.freeze({ fillColor: "#C7DEE7", fillOpacity: 155, lineColor: "#2D6F8E", lineWidth: 1, selectedLineColor: "#F59E0B", selectedLineWidth: 4 });
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
let currentTool = ViewerTool.SELECT;
let currentHits = [];
let currentHitIndex = -1;

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
  viewer.setLegendItems(currentHits.length > 0
    ? currentHits.map((hit, index) => ({
      shape: "none",
      label: `${index === currentHitIndex ? ">" : " "} ${index + 1} | ${hit.layerName ?? hit.layer ?? "-"} | ${hit.shapeId} | ${hit.featureId} | ${hit.shapeType ?? hit.type ?? "-"} | ${bestDisplayName(hit)}`,
    }))
    : [{ shape: "none", label: "No hits" }]);
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
    ["Extent", extentText(hit.extent)],
  ];
  for (const key of Object.keys(hit.attributes ?? {}).sort((left, right) => left.localeCompare(right))) rows.push([key, hit.attributes[key]]);
  viewer.appendLog("Property / Field     Value");
  for (const [name, value] of rows) viewer.appendLog(`${String(name).padEnd(20)} ${valueText(value)}`);
}

function showCurrentHit() {
  if (currentHitIndex < 0 || currentHitIndex >= currentHits.length) return;
  const hit = currentHits[currentHitIndex];
  updateHitsPanel();
  showDetails(hit);
  viewer.setStatusText(`Selected row ${currentHitIndex + 1}/${currentHits.length}: ${hit.layerName ?? hit.layer ?? "-"} feature ${hit.featureId}.`);
}

function activateSelect() {
  currentTool = ViewerTool.SELECT;
  viewer.setTool(ViewerTool.SELECT);
  viewer.setStatusText("API: hitTestFeaturesInScreenRect(screenRect). Drag a box to select features.");
}

function activatePan() {
  currentTool = ViewerTool.PAN;
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Tool: Pan.");
}

function clearSelection() {
  viewer.clearSelectedFeatures();
  currentHits = [];
  currentHitIndex = -1;
  updateHitsPanel();
  showEmptyDetails("Selection cleared.");
  viewer.setStatusText("Selection cleared.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SELECT) activateSelect();
  else if (commandId === COMMAND.PAN) activatePan();
  else if (commandId === COMMAND.CLEAR) clearSelection();
  else if (commandId === COMMAND.PREVIOUS && currentHits.length > 0) {
    currentHitIndex = (currentHitIndex - 1 + currentHits.length) % currentHits.length;
    showCurrentHit();
  } else if (commandId === COMMAND.NEXT && currentHits.length > 0) {
    currentHitIndex = (currentHitIndex + 1) % currentHits.length;
    showCurrentHit();
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

function handleSelectionBox(event) {
  const rect = event.screenRectangle;
  const left = Math.min(rect.left, rect.right);
  const top = Math.min(rect.top, rect.bottom);
  const right = Math.max(rect.left, rect.right);
  const bottom = Math.max(rect.top, rect.bottom);
  currentHits = viewer.hitTestFeaturesInScreenRect(left, top, right, bottom).filter((hit) => hit?.isValid);
  viewer.selectFeaturesInScreenRect(left, top, right, bottom, 0);
  currentHits = viewer.selectedFeatures().filter((hit) => hit?.isValid);
  currentHitIndex = currentHits.length > 0 ? 0 : -1;
  updateHitsPanel();
  if (currentHits.length === 0) showEmptyDetails("No features intersect the selection box.");
  else showDetails(currentHits[0]);
  viewer.setStatusText(`${currentHits.length} selected feature(s), screen rect: left=${left} top=${top} width=${right - left + 1} height=${bottom - top + 1}.`);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
    return;
  }
  if (event.eventType === ViewerEventType.MAP_SELECTION_BOX_FINISHED && currentTool === ViewerTool.SELECT) {
    setImmediate(() => {
      if (!viewer) return;
      try { handleSelectionBox(event); } catch (error) {
        viewer?.setStatusText(`Box selection failed: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "BoxSelect", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Box Select" },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.CLEAR, text: "Clear Selection" },
    { id: COMMAND.PREVIOUS, text: "Previous Row", separatorBefore: true },
    { id: COMMAND.NEXT, text: "Next Row" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLegendPanel("Selected by box");
  viewer.setLegendWidth(400);
  viewer.addLogPanel("Selected hit details");
  viewer.setTool(ViewerTool.SELECT);
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
  showEmptyDetails("Drag a selection box to list matching features.");
  activateSelect();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  currentTool = ViewerTool.SELECT;
  currentHits = [];
  currentHitIndex = -1;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
