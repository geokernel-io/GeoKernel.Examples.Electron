"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");

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
    throw new Error(
      [
        "GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll.",
        `Runtime bin: ${binDir}`,
        "Expected one of:",
        ...candidates.map((candidate) => `  - ${candidate}`),
        "Publish a new geokernel-electron package that includes the Qt platforms folder.",
      ].join("\n"),
    );
  }
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!viewer) {
      return;
    }

    viewer.processEvents();
    const visible = viewer.isVisible();
    if (visible) {
      viewerWasVisible = true;
      viewerHiddenSince = 0;
      return;
    }

    if (viewerWasVisible && viewerHiddenSince === 0) {
      viewerHiddenSince = Date.now();
    }

    if (viewerWasVisible && Date.now() - viewerHiddenSince > 750) {
      app.quit();
    }
  }, 16);
}

async function loadSampleLayers() {
  const [rasterLayer, worldLayer, citiesLayer] = await Promise.all([
    ensureSampleFile(
      `${SAMPLE_DATA_BASE_URL}world_8km_png.zip`,
      "world_8km_png.zip",
      "world_8km_png",
      "world_8km.png",
    ),
    ensureSampleFile(
      `${SAMPLE_DATA_BASE_URL}world_4326.zip`,
      "world_4326.zip",
      "world_4326",
      "world_4326.shp",
    ),
    ensureSampleFile(
      `${SAMPLE_DATA_BASE_URL}world_cities_4326.zip`,
      "world_cities_4326.zip",
      "world_cities_4326",
      "world_cities_4326.shp",
    ),
  ]);

  if (!viewer) {
    return;
  }

  viewer.clearLayers();

  viewer.addLayer(rasterLayer);
  viewer.setLayerName(0, "World raster");

  viewer.addLayer(worldLayer);
  viewer.setLayerName(0, "Countries");
  viewer.setLayerStyle(0, {
    fillColor: "#35475B",
    fillOpacity: 172,
    lineColor: "#B7E8FF",
    lineWidth: 0.85,
    labelColor: "#FFFFFF",
    labelHaloColor: "#10263A",
  });

  viewer.addLayer(citiesLayer);
  viewer.setLayerName(0, "Cities");
  viewer.setLayerStyle(0, {
    pointColor: "#1D8FC7",
    lineColor: "#74C3E8",
    lineWidth: 0.9,
    pointSize: 4.2,
  });

  viewer.refreshLayers();
  viewer.fullExtent();
}

async function start() {
  verifyQtPlatformPlugin();

  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
    },
  });

  viewer = new ViewerWindow({
    title: "AddLayers",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });

  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();

  await loadSampleLayers();
}

function stop() {
  if (eventPump) {
    clearInterval(eventPump);
    eventPump = null;
  }
  viewerWasVisible = false;
  viewerHiddenSince = 0;

  if (viewer) {
    viewer.close();
    viewer = null;
  }

  if (keeperWindow) {
    keeperWindow.close();
    keeperWindow = null;
  }
}

module.exports = {
  start,
  stop,
};
