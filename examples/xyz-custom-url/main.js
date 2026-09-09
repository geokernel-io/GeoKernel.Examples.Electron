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

const DEFAULT_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_EXTENT_3857 = extent(-1400000, 4100000, 4200000, 7800000);
const CONTROL = Object.freeze({
  URL: 1,
  MIN_ZOOM: 2,
  MAX_ZOOM: 3,
  CACHE: 4,
  APPLY: 5,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let applyTimer = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let urlTemplate = DEFAULT_URL;
let minZoom = 0;
let maxZoom = 19;
let cacheEnabled = true;

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

function isSupportedTileTemplate(value) {
  const hasXyz = ["{z}", "{x}", "{y}"].every((token) => value.includes(token));
  return hasXyz || value.includes("{q}");
}

function layerDetails() {
  return [
    "Custom XYZ URL sample",
    "",
    "Active URL template:",
    urlTemplate,
    "",
    `Min zoom: ${minZoom}`,
    `Max zoom: ${maxZoom}`,
    "Tile size: 256",
    `Local cache: ${cacheEnabled ? "enabled" : "disabled"}`,
    "",
    "SDK flow:",
    "viewer.addXyzLayer({ name, urlTemplate, minZoom, maxZoom, tileSize,",
    "  attribution, localCacheEnabled, cacheDirectory })",
    "",
    "Template requirements:",
    "- XYZ: {z}, {x}, {y}",
    "- or Bing style: {q}",
  ].join("\n");
}

function applyCustomUrl() {
  if (!viewer || closing) return;
  urlTemplate = urlTemplate.trim();
  if (!isSupportedTileTemplate(urlTemplate)) {
    viewer.setStatusText("URL must contain {z}, {x}, and {y}, or Bing-style {q}.");
    return;
  }
  if (maxZoom < minZoom) {
    viewer.setStatusText("Maximum zoom must be greater than or equal to minimum zoom.");
    return;
  }

  const cacheDirectory = path.join(
    __dirname, "..", "..", "outputs", "cache", "xyz-custom-url",
  );
  if (cacheEnabled) fs.mkdirSync(cacheDirectory, { recursive: true });

  viewer.clearLayers();
  const layerIndex = viewer.addXyzLayer({
    name: "Custom XYZ",
    urlTemplate,
    minZoom,
    maxZoom,
    tileSize: 256,
    attribution: "",
    localCacheEnabled: cacheEnabled,
    cacheDirectory: cacheEnabled ? cacheDirectory : "",
  });
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error("Custom XYZ layer could not be created.");
  }

  viewer.setViewExtent(DEFAULT_EXTENT_3857);
  viewer.clearLog();
  viewer.appendLog(layerDetails());
  viewer.setStatusText("Custom XYZ URL applied.");
}

function scheduleApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    try {
      applyCustomUrl();
    } catch (error) {
      if (!viewer) return;
      viewer.clearLog();
      viewer.appendLog(`Custom XYZ layer could not be loaded:\n${error.stack || error.message}`);
      viewer.setStatusText(`Custom XYZ URL failed: ${error.message}`);
    }
  }, 50);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (controlId === CONTROL.URL) {
    urlTemplate = textValue || "";
  } else if (controlId === CONTROL.MIN_ZOOM) {
    minZoom = Math.round(numericValue);
  } else if (controlId === CONTROL.MAX_ZOOM) {
    maxZoom = Math.round(numericValue);
  } else if (controlId === CONTROL.CACHE) {
    cacheEnabled = (textValue || "Enabled") === "Enabled";
  } else if (controlId === CONTROL.APPLY) {
    scheduleApply();
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
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
  if (viewer) {
    try {
      viewer.clearLayers();
      viewer.processEvents();
      viewer.close();
    } catch {
      // The native window may already have been destroyed.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
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
  viewer = new ViewerWindow({
    title: "XyzCustomUrl",
    width: 1280,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "Custom XYZ",
    area: "left",
    width: 540,
    controls: [
      {
        id: CONTROL.URL,
        type: "text",
        label: "URL",
        value: urlTemplate,
        minimumWidth: 430,
      },
      { id: CONTROL.MIN_ZOOM, type: "number", label: "Min", value: minZoom, minimum: 0, maximum: 21, step: 1, decimals: 0 },
      { id: CONTROL.MAX_ZOOM, type: "number", label: "Max", value: maxZoom, minimum: 0, maximum: 21, step: 1, decimals: 0 },
      { id: CONTROL.CACHE, type: "combo", label: "Local cache", options: ["Enabled", "Disabled"], value: "Enabled" },
      { id: CONTROL.APPLY, type: "button", text: "Apply URL" },
    ],
  }, onControlChanged);
  if (!viewer.setControlValue(CONTROL.URL, urlTemplate)) {
    throw new Error(
      "This GeoKernel runtime does not support text controls. Publish and install the release containing QLineEdit control-panel support.",
    );
  }
  viewer.addLogPanel("Custom XYZ details");
  viewer.setTool(ViewerTool.PAN);
  applyCustomUrl();
  viewer.show();
  viewer.processEvents();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  closing = true;
  urlTemplate = DEFAULT_URL;
  minZoom = 0;
  maxZoom = 19;
  cacheEnabled = true;
  if (viewer) {
    try {
      viewer.clearLayers();
      viewer.processEvents();
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
