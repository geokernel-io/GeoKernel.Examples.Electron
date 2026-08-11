"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const INITIAL_EXTENT = extent(-180, -58, 180, 82);
const HALO_COLORS = Object.freeze({
  White: "#FFFFFF",
  Black: "#000000",
  Yellow: "#FFF2A8",
  Blue: "#BAE6FD",
});
const CONTROL = Object.freeze({ ENABLED: 1, COLOR: 2, WIDTH: 3 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let worldLayerIndex = -1;
let ready = false;
const values = { enabled: true, colorName: "Yellow", width: 2.5 };

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

function haloStyle() {
  return {
    fillColor: "#D8E5E1",
    fillOpacity: 215,
    lineColor: "#6F8380",
    lineWidth: 0.8,
    showLabels: true,
    labelField: "COUNTRY",
    labelFontSize: 12,
    labelColor: "#253238",
    labelHaloEnabled: values.enabled,
    labelHaloColor: HALO_COLORS[values.colorName],
    labelHaloWidth: values.width,
  };
}

function applyHaloStyle() {
  if (!ready || worldLayerIndex < 0) return;
  viewer.setLayerStyle(worldLayerIndex, haloStyle());
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.processEvents();
  viewer.setStatusText(values.enabled
    ? `Halo color: ${HALO_COLORS[values.colorName]}, width: ${values.width.toFixed(1)}`
    : "Label halo disabled.");
}

function handleControl(controlId, numericValue, textValue) {
  if (controlId === CONTROL.ENABLED) values.enabled = textValue === "Yes";
  if (controlId === CONTROL.COLOR) values.colorName = textValue;
  if (controlId === CONTROL.WIDTH) values.width = numericValue;
  applyHaloStyle();
}

function onControlChanged(controlId, numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleControl(controlId, numericValue, textValue);
    } catch (error) {
      viewer?.setStatusText(`Label halo could not be updated: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "LabelHalo", width: 1200, height: 800, navigationToolbar: false });
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
    viewer.setLayerName(worldLayerIndex, "World - label halo");
    viewer.addControlPanel({
      title: "Label halo",
      width: 230,
      controls: [
        { id: CONTROL.ENABLED, type: "combo", label: "Halo enabled", options: ["Yes", "No"], value: "Yes" },
        { id: CONTROL.COLOR, type: "combo", label: "Halo color", options: Object.keys(HALO_COLORS), value: values.colorName },
        { id: CONTROL.WIDTH, type: "number", label: "Halo width", value: values.width, minimum: 0.5, maximum: 8, step: 0.5, decimals: 1 },
      ],
    }, onControlChanged);
    ready = true;
    applyHaloStyle();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    viewer.setStatusText("Labels use labelHaloEnabled, labelHaloColor and labelHaloWidth.");
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
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
