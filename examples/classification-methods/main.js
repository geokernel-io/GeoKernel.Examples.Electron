"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ClassificationMethod, ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/california.zip";
const POPULATION_FIELD = "POPULATION";
const COUNTY_STYLE = Object.freeze({
  fillColor: "#DCE8E4",
  fillOpacity: 225,
  lineColor: "#536B68",
  lineWidth: 0.8,
});
const METHODS = Object.freeze([
  ["Equal Interval", ClassificationMethod.EQUAL_INTERVAL],
  ["Quantile", ClassificationMethod.QUANTILE],
  ["Standard Deviation", ClassificationMethod.STANDARD_DEVIATION],
]);
const CONTROL = Object.freeze({ METHOD: 1 });

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

function methodValue(methodName) {
  return METHODS.find(([name]) => name === methodName)?.[1] ?? ClassificationMethod.EQUAL_INTERVAL;
}

function setLegendMessage(message) {
  viewer.setLegendItems([{ label: message, enabled: true, style: COUNTY_STYLE }]);
}

function updateLegend(methodName) {
  const renderer = viewer.layerSymbolRenderer(countyLayerIndex);
  const ranges = Array.isArray(renderer.ranges) ? renderer.ranges : [];
  viewer.setLegendTitle(`${POPULATION_FIELD} - ${methodName}`);
  viewer.setLegendItems(ranges);
}

function applyRenderer(methodName) {
  if (loading || countyLayerIndex < 0 || !methodName) return;
  const method = methodValue(methodName);
  const applied = viewer.applyGraduatedRenderer(countyLayerIndex, {
    fieldName: POPULATION_FIELD,
    method,
    classCount: 5,
    colorRampName: "GreenBlue",
    interval: method === ClassificationMethod.STANDARD_DEVIATION ? 1 : 0,
  });
  if (!applied) throw new Error(`Could not create graduated renderer from ${POPULATION_FIELD} field.`);
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  updateLegend(methodName);
  viewer.setStatusText(`Classification method applied: ${POPULATION_FIELD} / ${methodName}`);
}

function onControlChanged(controlId, numericValue, textValue) {
  void numericValue;
  if (controlId === CONTROL.METHOD) applyRenderer(textValue);
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
  viewer = new ViewerWindow({ title: "ClassificationMethods", width: 1200, height: 800, navigationToolbar: false });
  const initialMethod = METHODS[0][0];
  viewer.addLegendPanel(`${POPULATION_FIELD} - ${initialMethod}`);
  viewer.addControlPanel({
    title: "Classification",
    width: 230,
    area: "right",
    controls: [{
      id: CONTROL.METHOD,
      type: "combo",
      label: "Method",
      options: METHODS.map(([name]) => name),
      value: initialMethod,
    }],
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
    viewer.addLayer(countiesPath, {
      buildFeatureSource: true,
      applyDefaultStyle: true,
      defaultStyle: COUNTY_STYLE,
    });
    countyLayerIndex = 0;
    viewer.setLayerName(countyLayerIndex, "California counties - classification methods");
    viewer.setLayerStyle(countyLayerIndex, COUNTY_STYLE);
    loading = false;
    applyRenderer(initialMethod);
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
