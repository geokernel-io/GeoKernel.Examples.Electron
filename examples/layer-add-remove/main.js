"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const {
  ViewerTool,
  ViewerWindow,
  findBinDir,
} = require("geokernel-electron");

const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_RELEASE = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1";

const LAYERS = [
  {
    name: "World",
    archive: "world_4326.zip",
    folder: "world_4326",
    file: "world_4326.shp",
    style: {
      fillColor: "#D8E5E1",
      fillOpacity: 210,
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
      fillOpacity: 100,
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

async function prepareLayer(layer) {
  return {
    name: layer.name,
    path: await ensureSampleFile(
      `${SAMPLE_RELEASE}/${layer.archive}`,
      layer.archive,
      layer.folder,
      layer.file,
    ),
    style: layer.style,
  };
}

async function start() {
  verifyQtPlatformPlugin();
  const worldLayer = await prepareLayer(LAYERS[0]);

  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });

  viewer = new ViewerWindow({
    title: "LayerAddRemove",
    width: 1200,
    height: 800,
    navigationToolbar: false,
  });

  viewer.setTool(ViewerTool.PAN);
  viewer.addLayer(worldLayer.path);
  viewer.setLayerName(0, worldLayer.name);
  viewer.setLayerStyle(0, worldLayer.style);
  viewer.show();
  viewer.processEvents();
  viewer.fullExtent();
  viewer.processEvents();
  startEventPump();

  const optionalLayers = await Promise.all(LAYERS.slice(1).map(prepareLayer));
  if (viewer) {
    viewer.addLayerManagementToolbar({
      layers: [worldLayer, ...optionalLayers],
    });
    viewer.processEvents();
    viewer.fullExtent();
    viewer.processEvents();
  }
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
