"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const INITIAL_EXTENT = extent(-180, -58, 180, 82);
const CONTROL = Object.freeze({ ROTATION: 1, RESET: 2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let worldLayerIndex = -1;
let ready = false;
let resetting = false;
let rotation = 0;

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

function rotationStyle() {
  return {
    fillColor: "#D8E5E1",
    fillOpacity: 215,
    lineColor: "#6F8380",
    lineWidth: 0.8,
    showLabels: true,
    labelField: "COUNTRY",
    labelFontSize: 12,
    labelColor: "#253238",
    labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF",
    labelHaloWidth: 2,
    labelRotationDegrees: rotation,
  };
}

function applyRotation() {
  if (!ready || worldLayerIndex < 0) return;
  viewer.setLayerStyle(worldLayerIndex, rotationStyle());
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.processEvents();
  viewer.setStatusText(`Label rotation: ${rotation.toFixed(1)} degrees`);
}

function resetRotation() {
  resetting = true;
  try {
    rotation = 0;
    viewer.setControlValue(CONTROL.ROTATION, rotation);
  } finally {
    resetting = false;
  }
  applyRotation();
}

function handleControl(controlId, numericValue) {
  if (controlId === CONTROL.RESET) {
    resetRotation();
    return;
  }
  if (controlId === CONTROL.ROTATION) rotation = numericValue;
  if (!resetting) applyRotation();
}

function onControlChanged(controlId, numericValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleControl(controlId, numericValue);
    } catch (error) {
      viewer?.setStatusText(`Label rotation could not be updated: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
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
      if (Date.now() - viewerHiddenSince > 750) app.quit();
    }
  }, 16);
}

async function start() {
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "LabelRotation", width: 1200, height: 800, navigationToolbar: false });
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const worldPath = await ensureSampleFile(
      SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp",
    );
    if (!viewer) return;
    viewer.addLayer(worldPath, { buildFeatureSource: true });
    worldLayerIndex = 0;
    viewer.setLayerName(worldLayerIndex, "World - label rotation");
    viewer.addControlPanel({
      title: "Label rotation",
      width: 230,
      controls: [
        { id: CONTROL.ROTATION, type: "number", label: "Rotation", value: 0, minimum: -180, maximum: 180, step: 5, decimals: 1, suffix: " deg" },
        { id: CONTROL.RESET, type: "button", text: "Reset Rotation" },
      ],
    }, onControlChanged);
    ready = true;
    applyRotation();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    viewer.setStatusText("Labels use labelRotationDegrees.");
  } catch (error) {
    viewer?.setStatusText("World layer could not be loaded.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  worldLayerIndex = -1;
  ready = false;
  resetting = false;
  rotation = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
