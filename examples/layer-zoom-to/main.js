"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/california_cities.zip";
const PALETTE = ["#BFD6E5", "#C9D5C9", "#D8CDA7", "#D7B79B", "#D6C6E3", "#B9D8C5"];

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

function displayName(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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
  const firstPath = await ensureSampleFile(
    SAMPLE_URL,
    "california_cities.zip",
    "california_cities",
    "alameda.shp",
  );
  const cityFiles = fs.readdirSync(path.dirname(firstPath))
    .filter((file) => path.extname(file).toLowerCase() === ".shp")
    .sort((left, right) => left.localeCompare(right))
    .map((file) => path.join(path.dirname(firstPath), file));

  for (let index = 0; index < cityFiles.length; index += 1) {
    if (!viewer) return;
    const cityPath = cityFiles[index];
    viewer.addLayer(cityPath);
    viewer.setLayerName(0, displayName(cityPath));
    viewer.setLayerStyle(0, {
      fillColor: PALETTE[index % PALETTE.length],
      fillOpacity: 150,
      lineColor: "#5F7772",
      lineWidth: 0.8,
      showLabels: true,
      labelFontSize: 12,
      labelAllowOverlap: true,
      labelAvoidObstacles: false,
      labelField: "NAME",
      labelColor: "#000000",
      labelHaloEnabled: true,
      labelHaloColor: "#FFFF00",
      labelHaloWidth: 2,
    });
    viewer.processEvents();
  }

  if (!viewer) return;
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
    title: "Layer ZoomTo",
    width: 1200,
    height: 800,
    layerSelector: { action: "zoom" },
  });
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  await loadLayers();
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
