"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { OverlayAnchor, ViewerWindow, findBinDir } = require("geokernel-electron");

const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_DATA_BASE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/";

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

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
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll. Runtime bin: ${binDir}`);
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
      return;
    }
    if (viewerWasVisible && viewerHiddenSince === 0) viewerHiddenSince = Date.now();
    if (viewerWasVisible && Date.now() - viewerHiddenSince > 750) app.quit();
  }, 16);
}

async function loadSampleLayers() {
  const [worldLayer, citiesLayer] = await Promise.all([
    ensureSampleFile(`${SAMPLE_DATA_BASE_URL}world_4326.zip`, "world_4326.zip", "world_4326", "world_4326.shp"),
    ensureSampleFile(`${SAMPLE_DATA_BASE_URL}world_cities_4326.zip`, "world_cities_4326.zip", "world_cities_4326", "world_cities_4326.shp"),
  ]);

  if (!viewer) return;
  viewer.addLayer(worldLayer);
  viewer.addLayer(citiesLayer);
  viewer.setMapStyle("soft-professional", 1);
  viewer.setScaleBarVisible(true);
  viewer.setScaleBarAnchor(OverlayAnchor.BOTTOM_LEFT);
  viewer.fullExtent();
}

async function start() {
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "Measure", width: 1200, height: 800, navigationToolbar: false, measureToolbar: true });
  viewer.show();
  viewer.processEvents();
  startEventPump();
  await loadSampleLayers();
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
