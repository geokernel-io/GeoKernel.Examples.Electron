"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_BASE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/";
const SAMPLE_EXTENT = extent(-130, 22, -65, 55);
const COMMAND = Object.freeze({ SELECT: 1, PAN: 2, CLEAR: 3, FULL_EXTENT: 4 });
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

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
}

function bestDisplayName(hit) {
  const attributes = hit.attributes ?? {};
  for (const key of ["CITY_NAME", "NAME", "Name", "STATE", "STATE_NAME", "COUNTRY", "ADMIN"]) {
    if (String(attributes[key] ?? "").trim()) return String(attributes[key]);
  }
  return `Feature ${hit.featureId}`;
}

function updateSelectionPanel(emptyMessage = "No selected features.") {
  const selected = viewer.selectedFeatures().filter((hit) => hit?.isValid);
  viewer.setLegendTitle(`Selection set — ${selected.length}`);
  viewer.setLegendItems(selected.length > 0
    ? selected.map((hit, index) => ({
      shape: "none",
      label: `${index + 1} | ${hit.layerName ?? hit.layer ?? "-"} | ${hit.shapeId} | ${hit.featureId} | ${hit.shapeType ?? hit.type ?? "-"} | ${bestDisplayName(hit)}`,
    }))
    : [{ shape: "none", label: emptyMessage }]);
  return selected.length;
}

function activateSelect() {
  currentTool = ViewerTool.INFO;
  viewer.setTool(ViewerTool.INFO);
  viewer.setStatusText(`Click a feature to add it to selection. selectedFeatureCount=${viewer.selectedFeatureCount()}.`);
}

function activatePan() {
  currentTool = ViewerTool.PAN;
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Tool: Pan.");
}

function clearSelection() {
  viewer.clearSelectedFeatures();
  const count = updateSelectionPanel("Selection cleared.");
  viewer.setStatusText(`clearSelectedFeatures applied. selectedFeatureCount=${count}.`);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SELECT) activateSelect();
  else if (commandId === COMMAND.PAN) activatePan();
  else if (commandId === COMMAND.CLEAR) clearSelection();
  else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    viewer.setStatusText(`Sample extent restored. selectedFeatureCount=${viewer.selectedFeatureCount()}.`);
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

function addSelectionAt(event) {
  const x = event.screenRectangle.left;
  const y = event.screenRectangle.top;
  const added = viewer.addTopFeatureToSelectionAt(x, y, 8);
  if (!added) {
    viewer.setStatusText("No feature hit. Existing selection was preserved.");
    return;
  }
  const count = updateSelectionPanel();
  viewer.setStatusText(`addSelectedFeature applied. selectedFeatureCount=${count}.`);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ACTIVE_TOOL_CHANGED) {
    currentTool = event.intValue;
    return;
  }
  if (event.eventType === ViewerEventType.MAP_MOUSE_UP && currentTool === ViewerTool.INFO) {
    setImmediate(() => {
      if (!viewer) return;
      try { addSelectionAt(event); } catch (error) {
        viewer?.setStatusText(`Selection failed: ${error.message}`);
        console.error(error?.stack || error);
      }
    });
  } else if (event.eventType === ViewerEventType.SELECTION_CHANGED) {
    setImmediate(() => { if (viewer) updateSelectionPanel(); });
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
  viewer = new ViewerWindow({ title: "SelectClear", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.SELECT, text: "Select" },
    { id: COMMAND.PAN, text: "Pan" },
    { id: COMMAND.CLEAR, text: "clearSelectedFeatures", separatorBefore: true },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLegendPanel("Selection set");
  viewer.setLegendWidth(420);
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
  updateSelectionPanel();
  activateSelect();
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
