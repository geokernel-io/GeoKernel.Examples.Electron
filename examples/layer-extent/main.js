"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/california.zip";

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

function addExtentRectangle(layerIndex) {
  const layerExtent = viewer.layerProjectedExtent(layerIndex);
  if (!layerExtent || layerExtent.xMax <= layerExtent.xMin || layerExtent.yMax <= layerExtent.yMin) {
    throw new Error("California layer extent is empty.");
  }

  const rectangle = [[
    [layerExtent.xMin, layerExtent.yMin],
    [layerExtent.xMax, layerExtent.yMin],
    [layerExtent.xMax, layerExtent.yMax],
    [layerExtent.xMin, layerExtent.yMax],
    [layerExtent.xMin, layerExtent.yMin],
  ]];
  const result = viewer.addPolygonLayer("Layer Extent", rectangle, {
    fillColor: "#FFFFFF",
    fillOpacity: 0,
    lineColor: "#E2453D",
    lineWidth: 2.2,
  });
  if (result < 0) {
    throw new Error("Layer extent rectangle could not be created.");
  }
}

async function loadMap() {
  const californiaPath = await ensureSampleFile(
    SAMPLE_URL,
    "california.zip",
    "california",
    "california.shp",
  );
  if (!viewer) return;

  viewer.addLayer(californiaPath);
  viewer.setLayerName(0, "California");
  viewer.setLayerStyle(0, {
    fillColor: "#D8E5E1",
    fillOpacity: 210,
    lineColor: "#6F8883",
    lineWidth: 0.9,
  });
  addExtentRectangle(0);
  viewer.refreshLayers();
  viewer.fullExtent();
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
    title: "LayerExtent",
    width: 1200,
    height: 800,
  });
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  await loadMap();
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
