"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const INITIAL_EXTENT = extent(-180, -58, 180, 82);
const FONT_FAMILIES = Object.freeze([
  "Arial",
  "Calibri",
  "Cambria",
  "Consolas",
  "Courier New",
  "Georgia",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
]);
const CONTROL = Object.freeze({ FONT_FAMILY: 1, BOLD: 2, ITALIC: 3 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let worldLayerIndex = -1;
let ready = false;
const values = { fontFamily: "Arial", bold: false, italic: false };

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

function labelFontStyle() {
  return {
    fillColor: "#D8E5E1",
    fillOpacity: 215,
    lineColor: "#6F8380",
    lineWidth: 0.8,
    showLabels: true,
    labelField: "COUNTRY",
    labelFontSize: 12,
    labelColor: "#1F2933",
    labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF",
    labelHaloWidth: 2,
    labelFontFamily: values.fontFamily,
    labelBold: values.bold,
    labelItalic: values.italic,
  };
}

function applyLabelFont() {
  if (!ready || worldLayerIndex < 0 || !values.fontFamily) return;
  viewer.setLayerStyle(worldLayerIndex, labelFontStyle());
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.processEvents();
  viewer.setStatusText(
    `Font: ${values.fontFamily}, bold: ${String(values.bold)}, italic: ${String(values.italic)}`,
  );
}

function handleControl(controlId, textValue) {
  if (controlId === CONTROL.FONT_FAMILY) values.fontFamily = textValue;
  if (controlId === CONTROL.BOLD) values.bold = textValue === "Yes";
  if (controlId === CONTROL.ITALIC) values.italic = textValue === "Yes";
  applyLabelFont();
}

function onControlChanged(controlId, numericValue, textValue) {
  void numericValue;
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleControl(controlId, textValue);
    } catch (error) {
      viewer?.setStatusText(`Label font could not be updated: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "LabelFont", width: 1200, height: 800, navigationToolbar: false });
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
    viewer.setLayerName(worldLayerIndex, "World - label font");
    viewer.addControlPanel({
      title: "Label font",
      width: 245,
      controls: [
        { id: CONTROL.FONT_FAMILY, type: "combo", label: "Font family", options: FONT_FAMILIES, value: values.fontFamily },
        { id: CONTROL.BOLD, type: "combo", label: "Bold", options: ["No", "Yes"], value: "No" },
        { id: CONTROL.ITALIC, type: "combo", label: "Italic", options: ["No", "Yes"], value: "No" },
      ],
    }, onControlChanged);
    ready = true;
    applyLabelFont();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    viewer.setStatusText("Labels use labelFontFamily, labelBold and labelItalic.");
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
