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

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_EXTENT_3857 = extent(-1400000, 4100000, 4200000, 7800000);
const LEFT_TILE_SIZE = 256;
const RIGHT_TILE_SIZE = 512;
const COMMAND = Object.freeze({
  ZOOM_IN: 1,
  ZOOM_OUT: 2,
  FULL_EXTENT: 3,
  ZOOM_BOX: 4,
  PAN: 5,
});

let windowViewer = null;
let leftViewer = null;
let rightViewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

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

function cacheDirectoryFor(tileSize) {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "outputs",
    "cache",
    "xyz-tile-size",
    String(tileSize),
  );
}

function addTileLayer(viewer, tileSize) {
  const cacheDirectory = cacheDirectoryFor(tileSize);
  fs.mkdirSync(cacheDirectory, { recursive: true });
  viewer.clearLayers();
  const layerIndex = viewer.addXyzLayer({
    name: `OSM tileSize ${tileSize}`,
    urlTemplate: OSM_URL,
    minZoom: 0,
    maxZoom: 19,
    tileSize,
    attribution: "OpenStreetMap contributors",
    localCacheEnabled: true,
    cacheDirectory,
  });
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error(`${tileSize} px XYZ layer could not be created.`);
  }
  viewer.setViewExtent(DEFAULT_EXTENT_3857);
}

function setToolForBoth(tool) {
  leftViewer.setTool(tool);
  rightViewer.setTool(tool);
}

function showDefaultExtent() {
  leftViewer.setViewExtent(DEFAULT_EXTENT_3857);
  rightViewer.setViewExtent(DEFAULT_EXTENT_3857);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ZOOM_IN) {
    leftViewer.zoomIn();
    rightViewer.zoomIn();
  } else if (commandId === COMMAND.ZOOM_OUT) {
    leftViewer.zoomOut();
    rightViewer.zoomOut();
  } else if (commandId === COMMAND.FULL_EXTENT) {
    showDefaultExtent();
  } else if (commandId === COMMAND.ZOOM_BOX) {
    setToolForBoth(ViewerTool.ZOOM_BOX);
  } else if (commandId === COMMAND.PAN) {
    setToolForBoth(ViewerTool.PAN);
  }
}

function detailsText() {
  return [
    "XYZ tile size sample",
    "",
    "Left map:",
    "GisLayerXYZ + setTileSize(256)",
    "",
    "Right map:",
    "GisLayerXYZ + setTileSize(512)",
    "",
    "URL template:",
    OSM_URL,
    "",
    "Why this matters:",
    "- tileSize is the expected pixel size of one downloaded tile.",
    "- Standard OSM tiles are usually 256 px.",
    "- Some services expose 512 px retina/high-DPI tiles.",
    "- The cache key includes tileSize, so 256 and 512 variants stay separate.",
    "",
    "SDK flow:",
    "viewer.addXyzLayer({ name, urlTemplate, minZoom, maxZoom, tileSize,",
    "  attribution, localCacheEnabled, cacheDirectory })",
  ].join("\n");
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
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
}

function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  windowViewer = new ViewerWindow({
    title: "XyzTileSize",
    width: 1280,
    height: 800,
    navigationToolbar: false,
    viewerPanes: [
      "256 px tiles | setTileSize(256)",
      "512 px tiles | setTileSize(512)",
    ],
  });
  leftViewer = windowViewer.pane(0);
  rightViewer = windowViewer.pane(1);
  windowViewer.addCommandToolbar([
    { id: COMMAND.ZOOM_IN, text: "Zoom In" },
    { id: COMMAND.ZOOM_OUT, text: "Zoom Out" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
    { id: COMMAND.ZOOM_BOX, text: "Zoom Rect", separatorBefore: true },
    { id: COMMAND.PAN, text: "Pan" },
  ], handleCommand);
  windowViewer.addLogPanel("Tile size details");
  windowViewer.appendLog(detailsText());
  setToolForBoth(ViewerTool.PAN);
  addTileLayer(leftViewer, LEFT_TILE_SIZE);
  addTileLayer(rightViewer, RIGHT_TILE_SIZE);
  windowViewer.setStatusText("Compare GisLayerXYZ::setTileSize(256) and setTileSize(512).");
  windowViewer.show();
  windowViewer.processEvents();
  showDefaultExtent();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (windowViewer) {
    try {
      windowViewer.close();
    } catch {
      // The native window may already have been destroyed.
    }
  }
  windowViewer = null;
  leftViewer = null;
  rightViewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
