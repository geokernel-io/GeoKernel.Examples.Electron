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
const CONTROL = Object.freeze({
  MIN_ZOOM: 1,
  MAX_ZOOM: 2,
  APPLY: 3,
  LOW_RANGE: 4,
  MID_RANGE: 5,
  HIGH_RANGE: 6,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let applyTimer = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let minZoom = 0;
let maxZoom = 19;

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

function cacheDirectoryFor(minimumZoom, maximumZoom) {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "outputs",
    "cache",
    "xyz-min-max-zoom",
    `${minimumZoom}_${maximumZoom}`,
  );
}

function normalizedRange() {
  const minimum = Math.max(0, Math.min(21, Math.round(minZoom)));
  const maximum = Math.max(0, Math.min(21, Math.round(maxZoom)));
  return minimum <= maximum
    ? { minimum, maximum }
    : { minimum: maximum, maximum: minimum };
}

function detailsText(minimumZoom, maximumZoom) {
  return [
    "XYZ min/max zoom sample",
    "",
    "URL template:",
    OSM_URL,
    "",
    "Applied range:",
    `Min zoom: ${minimumZoom}`,
    `Max zoom: ${maximumZoom}`,
    "",
    "What it demonstrates:",
    "- setMinZoom limits the lowest tile zoom level.",
    "- setMaxZoom limits the highest tile zoom level.",
    "- Values are clamped by GisLayerXYZ to the safe internal range.",
    "- If min is greater than max, the range is normalized before applying it.",
    "",
    "SDK flow:",
    "viewer.addXyzLayer({ name, urlTemplate, minZoom, maxZoom, tileSize,",
    "  attribution, localCacheEnabled, cacheDirectory })",
  ].join("\n");
}

function applyZoomRange() {
  if (!viewer || closing) return;
  const range = normalizedRange();
  const previousExtent = viewer.layerCount() > 0
    ? viewer.getViewExtent()
    : DEFAULT_EXTENT_3857;
  const cacheDirectory = cacheDirectoryFor(range.minimum, range.maximum);
  fs.mkdirSync(cacheDirectory, { recursive: true });

  viewer.clearLayers();
  const layerIndex = viewer.addXyzLayer({
    name: `OSM min ${range.minimum} max ${range.maximum}`,
    urlTemplate: OSM_URL,
    minZoom: range.minimum,
    maxZoom: range.maximum,
    tileSize: 256,
    attribution: "OpenStreetMap contributors",
    localCacheEnabled: true,
    cacheDirectory,
  });
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error("XYZ min/max zoom layer could not be created.");
  }

  viewer.setViewExtent(previousExtent || DEFAULT_EXTENT_3857);
  viewer.clearLog();
  viewer.appendLog(detailsText(range.minimum, range.maximum));
  viewer.setStatusText(`XYZ min/max zoom applied: ${range.minimum} - ${range.maximum}`);
}

function scheduleApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    try {
      applyZoomRange();
    } catch (error) {
      viewer?.setStatusText(`XYZ min/max zoom failed: ${error.message}`);
    }
  }, 50);
}

function setAndApplyRange(minimum, maximum) {
  minZoom = minimum;
  maxZoom = maximum;
  viewer.setControlValue(CONTROL.MIN_ZOOM, minimum);
  viewer.setControlValue(CONTROL.MAX_ZOOM, maximum);
  scheduleApply();
}

function onControlChanged(controlId, numericValue) {
  if (controlId === CONTROL.MIN_ZOOM) {
    minZoom = numericValue;
  } else if (controlId === CONTROL.MAX_ZOOM) {
    maxZoom = numericValue;
  } else if (controlId === CONTROL.APPLY) {
    scheduleApply();
  } else if (controlId === CONTROL.LOW_RANGE) {
    setAndApplyRange(0, 5);
  } else if (controlId === CONTROL.MID_RANGE) {
    setAndApplyRange(4, 10);
  } else if (controlId === CONTROL.HIGH_RANGE) {
    setAndApplyRange(8, 14);
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
  minZoom = 0;
  maxZoom = 19;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "XyzMinMaxZoom",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "XYZ zoom range",
    area: "top",
    width: 650,
    controls: [
      { id: CONTROL.MIN_ZOOM, type: "number", label: "Min", value: 0, minimum: 0, maximum: 21, step: 1, decimals: 0 },
      { id: CONTROL.MAX_ZOOM, type: "number", label: "Max", value: 19, minimum: 0, maximum: 21, step: 1, decimals: 0 },
      { id: CONTROL.APPLY, type: "button", text: "Apply Zoom Range" },
      { id: CONTROL.LOW_RANGE, type: "button", text: "0-5" },
      { id: CONTROL.MID_RANGE, type: "button", text: "4-10" },
      { id: CONTROL.HIGH_RANGE, type: "button", text: "8-14" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Min/max zoom details");
  viewer.setTool(ViewerTool.PAN);
  applyZoomRange();
  viewer.show();
  viewer.processEvents();
  viewer.setViewExtent(DEFAULT_EXTENT_3857);
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) {
    try {
      viewer.close();
    } catch {
      // The native window may already have been destroyed.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
