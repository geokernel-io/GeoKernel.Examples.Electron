"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const INITIAL_EXTENT = extent(-180, -58, 180, 82);
const CONTROL = Object.freeze({ SHOW_LABELS: 1, FIELD: 2, FONT_SIZE: 3 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let worldLayerIndex = -1;
let ready = false;
const values = { showLabels: true, field: "COUNTRY", fontSize: 12 };

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

function labelStyle() {
  return {
    fillColor: "#D8E5E1",
    fillOpacity: 215,
    lineColor: "#6F8380",
    lineWidth: 0.8,
    showLabels: values.showLabels,
    labelField: values.field,
    labelFontSize: values.fontSize,
    labelColor: "#FFFF00",
    labelHaloEnabled: true,
    labelHaloColor: "#000000",
    labelHaloWidth: 2,
  };
}

function applyLabelStyle() {
  if (!ready || worldLayerIndex < 0 || !values.field) return;
  viewer.setLayerStyle(worldLayerIndex, labelStyle());
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.processEvents();
  viewer.setStatusText(values.showLabels
    ? `Label field: ${values.field}, font size: ${values.fontSize.toFixed(1)}`
    : "Labels disabled.");
}

function handleControl(controlId, numericValue, textValue) {
  if (controlId === CONTROL.SHOW_LABELS) values.showLabels = textValue === "Yes";
  if (controlId === CONTROL.FIELD) values.field = textValue;
  if (controlId === CONTROL.FONT_SIZE) values.fontSize = numericValue;
  applyLabelStyle();
}

function onControlChanged(controlId, numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleControl(controlId, numericValue, textValue);
    } catch (error) {
      viewer?.setStatusText(`Label style could not be updated: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "BasicLabel", width: 1200, height: 800, navigationToolbar: false });
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
    viewer.setLayerName(worldLayerIndex, "World - labels");
    const fields = viewer.layerAttributeDefinitions(worldLayerIndex)
      .map((definition) => String(definition.name ?? "").trim())
      .filter(Boolean);
    if (fields.length === 0) throw new Error("No label fields were found in the world layer schema.");
    values.field = fields.includes("COUNTRY") ? "COUNTRY" : fields[0];

    viewer.addControlPanel({
      title: "Label style",
      width: 230,
      controls: [
        { id: CONTROL.SHOW_LABELS, type: "combo", label: "Show labels", options: ["Yes", "No"], value: "Yes" },
        { id: CONTROL.FIELD, type: "combo", label: "Label field", options: fields, value: values.field },
        { id: CONTROL.FONT_SIZE, type: "number", label: "Font size", value: values.fontSize, minimum: 5, maximum: 32, step: 1, decimals: 1 },
      ],
    }, onControlChanged);
    ready = true;
    applyLabelStyle();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    viewer.setStatusText("Labels use showLabels, labelField and labelFontSize.");
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
