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
const DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors";
const CUSTOM_ATTRIBUTION = "Tiles © Custom Provider | Data © GeoKernel Sample";
const DEFAULT_EXTENT_3857 = extent(-1400000, 4100000, 4200000, 7800000);
const CONTROL = Object.freeze({
  ATTRIBUTION: 1,
  APPLY: 2,
  OSM: 3,
  CUSTOM: 4,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let applyTimer = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let attributionText = DEFAULT_ATTRIBUTION;

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

function cacheDirectory() {
  return path.resolve(__dirname, "..", "..", "outputs", "cache", "xyz-attribution", "osm");
}

function detailsText(attribution) {
  return [
    "XYZ attribution sample",
    "",
    "URL template:",
    OSM_URL,
    "",
    "Applied attribution:",
    attribution,
    "",
    "What this sample shows:",
    "- GisLayerXYZ stores attribution metadata on the layer.",
    "- The sample also renders the same text at the bottom of the map window.",
    "- Project save/load preserves attribution for XYZ/WMS/WMTS layers.",
    "",
    "SDK flow:",
    "viewer.addXyzLayer({ name, urlTemplate, minZoom, maxZoom, tileSize, attribution })",
    "viewer.setAttributionText(attribution)",
  ].join("\n");
}

function applyAttribution() {
  if (!viewer || closing) return;
  const attribution = attributionText.trim() || "No attribution";
  const previousExtent = viewer.layerCount() > 0
    ? viewer.getViewExtent()
    : DEFAULT_EXTENT_3857;
  const directory = cacheDirectory();
  fs.mkdirSync(directory, { recursive: true });

  viewer.clearLayers();
  const layerIndex = viewer.addXyzLayer({
    name: "OSM Attribution",
    urlTemplate: OSM_URL,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    attribution,
    localCacheEnabled: true,
    cacheDirectory: directory,
  });
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error("XYZ attribution layer could not be created.");
  }

  viewer.setViewExtent(previousExtent || DEFAULT_EXTENT_3857);
  viewer.setAttributionText(attribution);
  viewer.clearLog();
  viewer.appendLog(detailsText(attribution));
  viewer.setStatusText("XYZ attribution applied.");
}

function scheduleApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    try {
      applyAttribution();
    } catch (error) {
      viewer?.setStatusText(`XYZ attribution failed: ${error.message}`);
    }
  }, 50);
}

function setAndApplyAttribution(value) {
  attributionText = value;
  viewer.setControlValue(CONTROL.ATTRIBUTION, value);
  scheduleApply();
}

function onControlChanged(controlId, _numericValue, textValue) {
  if (controlId === CONTROL.ATTRIBUTION) {
    attributionText = textValue;
  } else if (controlId === CONTROL.APPLY) {
    scheduleApply();
  } else if (controlId === CONTROL.OSM) {
    setAndApplyAttribution(DEFAULT_ATTRIBUTION);
  } else if (controlId === CONTROL.CUSTOM) {
    setAndApplyAttribution(CUSTOM_ATTRIBUTION);
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
  attributionText = DEFAULT_ATTRIBUTION;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "XyzAttribution",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "XYZ attribution",
    area: "top",
    width: 650,
    controls: [
      { id: CONTROL.ATTRIBUTION, type: "text", label: "Attribution", value: DEFAULT_ATTRIBUTION, minimumWidth: 390 },
      { id: CONTROL.APPLY, type: "button", text: "Apply Attribution" },
      { id: CONTROL.OSM, type: "button", text: "OSM" },
      { id: CONTROL.CUSTOM, type: "button", text: "Custom" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Attribution details");
  viewer.setTool(ViewerTool.PAN);
  applyAttribution();
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
