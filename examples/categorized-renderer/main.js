"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/usa_states_3857.zip";
const INITIAL_EXTENT = extent(-16831516, 1856556, -4631023, 7472472);
const STATE_STYLE = {
  fillColor: "#D8E5E1",
  fillOpacity: 220,
  lineColor: "#536B68",
  lineWidth: 0.9,
};

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

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

function setLegendMessage(message) {
  viewer.setLegendItems([{ label: message, enabled: true, style: STATE_STYLE }]);
}

function updateLegend(layerIndex) {
  const renderer = viewer.layerSymbolRenderer(layerIndex);
  const categories = Array.isArray(renderer.categories) ? renderer.categories : [];
  viewer.setLegendItems(categories);
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
  viewer = new ViewerWindow({ title: "CategorizedRenderer", width: 1200, height: 800, navigationToolbar: false });
  viewer.addLegendPanel("STATE categories");
  viewer.setTool(ViewerTool.PAN);
  setLegendMessage("Preparing USA states sample data...");
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
    viewer.addLayer(statesPath, { buildFeatureSource: true });
    const statesIndex = 0;
    viewer.setLayerName(statesIndex, "USA States - categorized by STATE");
    viewer.setLayerStyle(statesIndex, STATE_STYLE);
    const applied = viewer.applyCategorizedRenderer(statesIndex, {
      fieldName: "STATE",
      colorRampName: "Unique",
      categoryLimit: 64,
    });
    if (!applied) throw new Error("Could not create categorized renderer from STATE field.");
    viewer.invalidateRenderCache(false, true);
    viewer.refreshLayers();
    updateLegend(statesIndex);
    viewer.processEvents();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    viewer.setStatusText("Categorized renderer applied: STATE");
  } catch (error) {
    setLegendMessage("Categorized renderer could not be created.");
    viewer?.setStatusText("Categorized renderer could not be created.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
