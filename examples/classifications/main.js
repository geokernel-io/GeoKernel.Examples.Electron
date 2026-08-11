"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const {
  ClassificationMethod,
  ColorRampMode,
  SymbolStyleTarget,
  ViewerTool,
  ViewerWindow,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/california.zip";
const BASE_STYLE = Object.freeze({
  fillColor: "#DCE8E4",
  fillOpacity: 225,
  lineColor: "#536B68",
  lineWidth: 0.8,
});
const MANUAL_BREAKS = Object.freeze([0, 100000, 500000, 1000000, 5000000, 10000000]);
const METHOD_VALUES = Object.freeze({
  "Equal Interval": ClassificationMethod.EQUAL_INTERVAL,
  Quantile: ClassificationMethod.QUANTILE,
  Quartile: ClassificationMethod.QUARTILE,
  "Natural Breaks": ClassificationMethod.NATURAL_BREAKS,
  "Geometrical Interval": ClassificationMethod.GEOMETRICAL_INTERVAL,
  "K-Means": ClassificationMethod.KMEANS,
  "K-Means Spatial": ClassificationMethod.KMEANS_SPATIAL,
  "Standard Deviation": ClassificationMethod.STANDARD_DEVIATION,
  "Standard Deviation with Central": ClassificationMethod.STANDARD_DEVIATION_WITH_CENTRAL,
  "Defined Interval": ClassificationMethod.DEFINED_INTERVAL,
  Manual: ClassificationMethod.MANUAL,
});
const TARGET_VALUES = Object.freeze({
  Color: SymbolStyleTarget.COLOR,
  "Size / Width": SymbolStyleTarget.SIZE_OR_WIDTH,
  "Outline color": SymbolStyleTarget.OUTLINE_COLOR,
  "Outline width": SymbolStyleTarget.OUTLINE_WIDTH,
});
const CONTROL = Object.freeze({
  RENDERER: 1,
  FIELD: 2,
  METHOD: 3,
  CLASS_COUNT: 4,
  INTERVAL: 5,
  RENDER_BY: 6,
  RAMP: 7,
  RAMP_MODE: 8,
  REVERSE: 9,
  APPLY: 10,
  CLEAR: 11,
  FULL_EXTENT: 12,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let layerIndex = -1;
let ready = false;
let fieldNames = [];
let numericFields = [];
const values = {
  renderer: "Graduated",
  field: "POPULATION",
  method: "Natural Breaks",
  classCount: 15,
  interval: 100000,
  renderBy: "Color",
  ramp: "GreenBlue",
  rampMode: "Continuous",
  reverse: "No",
};

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

function preferredField(renderer) {
  const preferred = renderer === "Categorized" ? "STATEFP" : "POPULATION";
  const candidates = renderer === "Categorized" ? fieldNames : numericFields;
  return candidates.includes(preferred) ? preferred : candidates[0] ?? fieldNames[0] ?? "";
}

function legendItems() {
  const renderer = viewer.layerSymbolRenderer(layerIndex);
  if (Array.isArray(renderer.categories)) return renderer.categories;
  if (Array.isArray(renderer.ranges)) return renderer.ranges;
  return [];
}

function updateLegend() {
  viewer.setLegendItems(legendItems().map((item) => ({ ...item, shape: "polygon" })));
}

function refreshViewer() {
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  updateLegend();
  viewer.processEvents();
}

function applyClassification() {
  if (!ready || layerIndex < 0 || !values.field) return;
  viewer.setLayerStyle(layerIndex, BASE_STYLE);
  let applied = false;
  if (values.renderer === "Categorized") {
    applied = viewer.applyCategorizedRenderer(layerIndex, {
      fieldName: values.field,
      colorRampName: values.ramp,
      categoryLimit: Math.round(values.classCount),
      reverseColorRamp: values.reverse === "Yes",
      styleTarget: TARGET_VALUES[values.renderBy],
    });
  } else {
    applied = viewer.applyGraduatedRenderer(layerIndex, {
      fieldName: values.field,
      method: METHOD_VALUES[values.method],
      classCount: Math.round(values.classCount),
      colorRampName: values.ramp,
      interval: values.interval,
      manualBreaks: values.method === "Manual" ? MANUAL_BREAKS : [],
      colorRampMode: values.rampMode === "Discrete" ? ColorRampMode.DISCRETE : ColorRampMode.CONTINUOUS,
      reverseColorRamp: values.reverse === "Yes",
      styleTarget: TARGET_VALUES[values.renderBy],
    });
  }
  if (!applied) throw new Error(`Renderer could not be created for field '${values.field}'.`);
  refreshViewer();
  viewer.setStatusText(`Classification applied on ${values.field}`);
}

function clearRenderer() {
  if (!ready || layerIndex < 0) return;
  if (!viewer.clearLayerSymbolRenderer(layerIndex)) throw new Error("Renderer could not be cleared.");
  viewer.setLayerStyle(layerIndex, BASE_STYLE);
  viewer.setLegendItems([]);
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.processEvents();
  viewer.setStatusText("Renderer cleared");
}

function handleControl(controlId, numericValue, textValue) {
  if (controlId === CONTROL.RENDERER) {
    values.renderer = textValue;
    values.field = preferredField(textValue);
    values.ramp = textValue === "Categorized" ? "Unique" : "GreenBlue";
    viewer.setControlValue(CONTROL.FIELD, values.field);
    viewer.setControlValue(CONTROL.RAMP, values.ramp);
  } else if (controlId === CONTROL.FIELD) values.field = textValue;
  else if (controlId === CONTROL.METHOD) {
    values.method = textValue;
    if ((textValue === "Standard Deviation" || textValue === "Standard Deviation with Central") && values.interval > 10) {
      values.interval = 1;
      viewer.setControlValue(CONTROL.INTERVAL, values.interval);
    }
  } else if (controlId === CONTROL.CLASS_COUNT) values.classCount = numericValue;
  else if (controlId === CONTROL.INTERVAL) values.interval = numericValue;
  else if (controlId === CONTROL.RENDER_BY) values.renderBy = textValue;
  else if (controlId === CONTROL.RAMP) values.ramp = textValue;
  else if (controlId === CONTROL.RAMP_MODE) values.rampMode = textValue;
  else if (controlId === CONTROL.REVERSE) values.reverse = textValue;
  else if (controlId === CONTROL.APPLY) applyClassification();
  else if (controlId === CONTROL.CLEAR) clearRenderer();
  else if (controlId === CONTROL.FULL_EXTENT) viewer.fullExtent();
}

function onControlChanged(controlId, numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      handleControl(controlId, numericValue, textValue);
    } catch (error) {
      viewer?.setStatusText(error.message);
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
  viewer = new ViewerWindow({ title: "Classifications", width: 1240, height: 760, navigationToolbar: false });
  viewer.addLegendPanel("Legend");
  viewer.setLegendWidth(240);
  viewer.setLegendItems([{ label: "Preparing California sample data...", enabled: true, shape: "none" }]);
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing California sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const californiaPath = await ensureSampleFile(
      SAMPLE_URL, "california.zip", "california", "california.shp",
    );
    if (!viewer) return;
    viewer.addOpenStreetMapLayer();
    viewer.addLayer(californiaPath, { buildFeatureSource: true });
    layerIndex = 0;
    viewer.setLayerName(layerIndex, "California counties - classification");
    viewer.setLayerStyle(layerIndex, BASE_STYLE);

    const definitions = viewer.layerAttributeDefinitions(layerIndex);
    fieldNames = definitions.map((definition) => String(definition.name ?? "").trim()).filter(Boolean);
    numericFields = definitions
      .filter((definition) => Number(definition.type) === 1 || Number(definition.type) === 2)
      .map((definition) => String(definition.name ?? "").trim())
      .filter(Boolean);
    if (fieldNames.length === 0 || numericFields.length === 0) {
      throw new Error("No compatible attribute fields were found in the California layer schema.");
    }
    values.field = preferredField(values.renderer);
    const rampNames = viewer.colorRampNames();
    const ramps = rampNames.length > 0 ? rampNames : ["GreenBlue", "Unique", "Viridis", "Plasma"];
    if (!ramps.includes(values.ramp)) values.ramp = ramps[0];

    viewer.addControlPanel({
      title: "Classification controls",
      width: 285,
      area: "right",
      controls: [
        { id: CONTROL.RENDERER, type: "combo", label: "Renderer", options: ["Categorized", "Graduated"], value: values.renderer },
        { id: CONTROL.FIELD, type: "combo", label: "Field", options: fieldNames, value: values.field },
        { id: CONTROL.METHOD, type: "combo", label: "Method", options: Object.keys(METHOD_VALUES), value: values.method },
        { id: CONTROL.CLASS_COUNT, type: "number", label: "Classes", value: values.classCount, minimum: 2, maximum: 64, step: 1, decimals: 0 },
        { id: CONTROL.INTERVAL, type: "number", label: "Interval", value: values.interval, minimum: 0.0001, maximum: 1000000000, step: 1000, decimals: 4 },
        { id: CONTROL.RENDER_BY, type: "combo", label: "Render by", options: Object.keys(TARGET_VALUES), value: values.renderBy },
        { id: CONTROL.RAMP, type: "combo", label: "Ramp", options: ramps, value: values.ramp },
        { id: CONTROL.RAMP_MODE, type: "combo", label: "Ramp mode", options: ["Continuous", "Discrete"], value: values.rampMode },
        { id: CONTROL.REVERSE, type: "combo", label: "Reverse", options: ["No", "Yes"], value: values.reverse },
        { id: CONTROL.APPLY, type: "button", text: "Apply" },
        { id: CONTROL.CLEAR, type: "button", text: "Clear" },
        { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      ],
    }, onControlChanged);
    ready = true;
    applyClassification();
    viewer.processEvents();
    viewer.zoomToLayer(layerIndex);
    viewer.processEvents();
  } catch (error) {
    viewer?.setLegendItems([{ label: "Classification could not be initialized.", enabled: true, shape: "none" }]);
    viewer?.setStatusText("Classification could not be initialized.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  layerIndex = -1;
  ready = false;
  fieldNames = [];
  numericFields = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
