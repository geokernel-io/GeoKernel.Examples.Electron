"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ClassificationMethod, ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/california.zip";
const COUNTY_STYLE = Object.freeze({
  fillColor: "#DCE8E4",
  fillOpacity: 225,
  lineColor: "#536B68",
  lineWidth: 0.8,
});
const CONTROL = Object.freeze({ COLOR_RAMP: 1 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let countyLayerIndex = -1;
let loading = true;

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

function setLegendMessage(message) {
  viewer.setLegendItems([{ label: message, enabled: true, style: COUNTY_STYLE }]);
}

function updateLegend() {
  const renderer = viewer.layerSymbolRenderer(countyLayerIndex);
  const ranges = Array.isArray(renderer.ranges) ? renderer.ranges : [];
  viewer.setLegendItems(ranges);
}

function applyRenderer(rampName) {
  if (loading || countyLayerIndex < 0 || !rampName) return;
  const applied = viewer.applyGraduatedRenderer(countyLayerIndex, {
    fieldName: "POPULATION",
    method: ClassificationMethod.NATURAL_BREAKS,
    classCount: 5,
    colorRampName: rampName,
  });
  if (!applied) throw new Error("Could not create graduated renderer from POPULATION field.");
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  updateLegend();
  viewer.setStatusText(`Graduated renderer applied: POPULATION / ${rampName}`);
}

function onControlChanged(controlId, numericValue, textValue) {
  void numericValue;
  if (controlId === CONTROL.COLOR_RAMP) applyRenderer(textValue);
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
  viewer = new ViewerWindow({ title: "GraduatedRenderer", width: 1200, height: 800, navigationToolbar: false });
  const ramps = viewer.colorRampNames();
  const initialRamp = ramps.includes("GreenBlue") ? "GreenBlue" : ramps[0];
  viewer.addLegendPanel("POPULATION classes");
  viewer.addControlPanel({
    title: "Renderer",
    width: 230,
    area: "right",
    controls: [{ id: CONTROL.COLOR_RAMP, type: "combo", label: "Color ramp", options: ramps, value: initialRamp }],
  }, onControlChanged);
  viewer.setTool(ViewerTool.PAN);
  setLegendMessage("Preparing California sample data...");
  viewer.setStatusText("Preparing California sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const countiesPath = await ensureSampleFile(
      SAMPLE_URL, "california.zip", "california", "california.shp",
    );
    if (!viewer) return;
    viewer.addOpenStreetMapLayer();
    viewer.addLayer(countiesPath, { buildFeatureSource: true });
    countyLayerIndex = 0;
    viewer.setLayerName(countyLayerIndex, "California counties - graduated by POPULATION");
    viewer.setLayerStyle(countyLayerIndex, COUNTY_STYLE);
    loading = false;
    applyRenderer(initialRamp);
    viewer.processEvents();
    viewer.zoomToLayer(countyLayerIndex);
    viewer.processEvents();
  } catch (error) {
    setLegendMessage("Graduated renderer could not be created.");
    viewer?.setStatusText("Graduated renderer could not be created.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  countyLayerIndex = -1;
  loading = true;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
