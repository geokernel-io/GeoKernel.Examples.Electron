"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const WORLD_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const CITIES_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_cities_4326.zip";
const INITIAL_EXTENT = extent(-127, 23, -66, 50);

const WORLD_STYLE = Object.freeze({
  fillColor: "#D8E5E1",
  fillOpacity: 215,
  lineColor: "#6F8380",
  lineWidth: 0.8,
});

let windowViewer = null;
let collisionOnViewer = null;
let collisionOffViewer = null;
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

function cityStyle(allowOverlap) {
  return {
    pointColor: "#D56037",
    lineColor: "#A23D23",
    pointSize: 5.5,
    lineWidth: 0.8,
    showLabels: true,
    labelField: "CITY_NAME",
    labelFontSize: 8,
    labelColor: "#1F2933",
    labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF",
    labelHaloWidth: 1.5,
    labelAllowOverlap: allowOverlap,
    labelPlacementMode: "Point",
    labelOffsetX: 7,
    labelOffsetY: -7,
  };
}

function loadComparisonLayers(targetViewer, worldPath, citiesPath, allowOverlap) {
  targetViewer.addLayer(worldPath, { buildFeatureSource: true });
  targetViewer.addLayer(citiesPath, { buildFeatureSource: true });
  const citiesLayerIndex = 0;
  const worldLayerIndex = 1;
  targetViewer.setLayerName(worldLayerIndex, "World");
  targetViewer.setLayerName(
    citiesLayerIndex,
    allowOverlap ? "Cities - labelAllowOverlap true" : "Cities - labelAllowOverlap false",
  );
  targetViewer.setLayerStyle(worldLayerIndex, WORLD_STYLE);
  targetViewer.setLayerStyle(citiesLayerIndex, cityStyle(allowOverlap));
  targetViewer.invalidateRenderCache(true, true);
  targetViewer.refreshLayers();
  targetViewer.setViewExtent(INITIAL_EXTENT);
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!windowViewer) return;
    windowViewer.processEvents();
    if (windowViewer.isVisible()) {
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
  windowViewer = new ViewerWindow({
    title: "LabelCollisionOff",
    width: 1300,
    height: 800,
    navigationToolbar: false,
    viewerPanes: ["labelAllowOverlap = false", "labelAllowOverlap = true"],
  });
  collisionOnViewer = windowViewer.pane(0);
  collisionOffViewer = windowViewer.pane(1);
  collisionOnViewer.setTool(ViewerTool.PAN);
  collisionOffViewer.setTool(ViewerTool.PAN);
  windowViewer.setStatusText("Preparing world and city sample data...");
  windowViewer.show();
  windowViewer.processEvents();
  startEventPump();

  try {
    const [worldPath, citiesPath] = await Promise.all([
      ensureSampleFile(WORLD_URL, "world_4326.zip", "world_4326", "world_4326.shp"),
      ensureSampleFile(CITIES_URL, "world_cities_4326.zip", "world_cities_4326", "world_cities_4326.shp"),
    ]);
    if (!windowViewer) return;
    loadComparisonLayers(collisionOnViewer, worldPath, citiesPath, false);
    loadComparisonLayers(collisionOffViewer, worldPath, citiesPath, true);
    windowViewer.processEvents();
    windowViewer.setStatusText("Left: collision filtering. Right: label overlap allowed.");
  } catch (error) {
    windowViewer?.setStatusText("World or city layers could not be loaded.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (windowViewer) windowViewer.close();
  windowViewer = null;
  collisionOnViewer = null;
  collisionOffViewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
