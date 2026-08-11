"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const {
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");

const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_RELEASE = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1";
const INITIAL_EXTENT = extent(-151.2, 16.4, -41.6, 55.6);
const LAYERS = [
  {
    name: "World",
    archive: "world_4326.zip",
    folder: "world_4326",
    file: "world_4326.shp",
    style: {
      fillColor: "#D8E5E1",
      fillOpacity: 220,
      lineColor: "#7B918D",
      lineWidth: 0.8,
    },
  },
  {
    name: "States",
    archive: "usa_states.zip",
    folder: "usa_states",
    file: "usa_states.shp",
    style: {
      fillColor: "#A9C8DB",
      fillOpacity: 115,
      lineColor: "#356780",
      lineWidth: 1.2,
    },
  },
  {
    name: "Cities",
    archive: "usa_cities.zip",
    folder: "usa_cities",
    file: "usa_cities.shp",
    style: {
      pointColor: "#D95D39",
      pointSize: 7,
    },
  },
];

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
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
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

async function loadLayers() {
  for (const layer of LAYERS) {
    const layerPath = await ensureSampleFile(
      `${SAMPLE_RELEASE}/${layer.archive}`,
      layer.archive,
      layer.folder,
      layer.file,
    );
    if (!viewer) return;

    viewer.addLayer(layerPath);
    viewer.setLayerName(0, layer.name);
    viewer.setLayerStyle(0, layer.style);
    viewer.processEvents();
  }

  if (!viewer) return;
  viewer.refreshLayers();
  viewer.setViewExtent(INITIAL_EXTENT);
  viewer.processEvents();
}

async function start() {
  verifyQtPlatformPlugin();

  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });

  viewer = new ViewerWindow({
    title: "LayerVisibility",
    width: 1200,
    height: 800,
    navigationToolbar: true,
    layerPanel: { allowVisibility: true },
  });
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();

  await loadLayers();
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

module.exports = { start, stop };
