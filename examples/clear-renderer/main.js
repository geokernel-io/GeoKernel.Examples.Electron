"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/usa_states_3857.zip";
const INITIAL_EXTENT = extent(-16831516, 1856556, -4631023, 7472472);
const STATE_STYLE = Object.freeze({
  fillColor: "#D8E5E1",
  fillOpacity: 220,
  lineColor: "#536B68",
  lineWidth: 0.9,
});
const COMMAND = Object.freeze({ APPLY: 1, CLEAR: 2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let statesLayerIndex = -1;
let sampleReady = false;

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

function refreshViewer() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.processEvents();
}

function applyCategorizedRenderer() {
  if (!sampleReady || statesLayerIndex < 0) return;
  viewer.setLayerStyle(statesLayerIndex, STATE_STYLE);
  const applied = viewer.applyCategorizedRenderer(statesLayerIndex, {
    fieldName: "STATE",
    colorRampName: "Unique",
    categoryLimit: 64,
  });
  if (!applied) throw new Error("Could not create categorized renderer from STATE field.");
  refreshViewer();
  viewer.setStatusText("Renderer: categorized by STATE | Categorized renderer applied.");
}

function clearRenderer() {
  if (!sampleReady || statesLayerIndex < 0) return;
  if (!viewer.clearLayerSymbolRenderer(statesLayerIndex)) {
    viewer.setStatusText("Renderer could not be cleared.");
    return;
  }
  viewer.setLayerStyle(statesLayerIndex, STATE_STYLE);
  refreshViewer();
  viewer.setStatusText("Renderer: none, default layer style | Symbol renderer cleared.");
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      if (commandId === COMMAND.APPLY) applyCategorizedRenderer();
      if (commandId === COMMAND.CLEAR) clearRenderer();
    } catch (error) {
      viewer?.setStatusText(`Renderer operation failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
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
  viewer = new ViewerWindow({ title: "ClearRenderer", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.APPLY, text: "Apply Categorized Renderer" },
    { id: COMMAND.CLEAR, text: "Clear Renderer" },
  ], onCommand);
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing USA states sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const statesPath = await ensureSampleFile(
      SAMPLE_URL, "usa_states_3857.zip", "usa_states_3857", "usa_states_3857.shp",
    );
    if (!viewer) return;
    viewer.addOpenStreetMapLayer();
    viewer.addLayer(statesPath, {
      buildFeatureSource: true,
      applyDefaultStyle: true,
      defaultStyle: STATE_STYLE,
    });
    statesLayerIndex = 0;
    viewer.setLayerName(statesLayerIndex, "USA States");
    viewer.setLayerStyle(statesLayerIndex, STATE_STYLE);
    sampleReady = true;
    applyCategorizedRenderer();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    viewer.setStatusText("Renderer: categorized by STATE | Use Clear Renderer to return to the default layer style.");
  } catch (error) {
    viewer?.setStatusText("ClearRenderer sample could not be created.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  statesLayerIndex = -1;
  sampleReady = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
