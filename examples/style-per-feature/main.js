"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/california.zip";
const DEFAULT_STYLE = Object.freeze({
  fillColor: "#AAE5E7EB",
  fillOpacity: 170,
  lineColor: "#EB6B7280",
  lineWidth: 1.2,
});
const ZONE_STYLES = Object.freeze({
  Residential: { fillColor: "#AAF5DFA1", fillOpacity: 170, lineColor: "#EBA16207", lineWidth: 1.2 },
  Commercial: { fillColor: "#AA9DD7F5", fillOpacity: 170, lineColor: "#EB0369A1", lineWidth: 1.2 },
  Industrial: { fillColor: "#AAC4B5FD", fillOpacity: 170, lineColor: "#EB6D28D9", lineWidth: 1.2 },
  Park: { fillColor: "#AA9AD9A8", fillOpacity: 170, lineColor: "#EB15803D", lineWidth: 1.2 },
  Mixed: { fillColor: "#AAFDBA9A", fillOpacity: 170, lineColor: "#EBC2410C", lineWidth: 1.2 },
});
const ZONES = Object.freeze(Object.keys(ZONE_STYLES));
const CONTROL = Object.freeze({ FEATURE: 1, ZONE: 2, APPLY: 3 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let countyLayerIndex = -1;
let selectedCountyIndex = 0;
let pendingZone = ZONES[0];
let updatingControls = true;
let counties = [];

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

function attributeValue(attributes, candidates) {
  for (const candidate of candidates) {
    const key = Object.keys(attributes).find((name) => name.toLowerCase() === candidate.toLowerCase());
    const value = key ? String(attributes[key] ?? "").trim() : "";
    if (value) return { key, value };
  }
  return null;
}

function loadCountyStates() {
  const info = viewer.layerInfo(countyLayerIndex);
  const expectedCount = Number(info.featureCount ?? info.features ?? 0);
  const maximumRows = expectedCount > 0 ? expectedCount : 1000;
  const result = [];
  let nameField = "NAME";

  for (let row = 0; row < maximumRows; row += 1) {
    const attributes = viewer.layerFeatureAttributes(countyLayerIndex, row);
    if (!attributes || Object.keys(attributes).length === 0) {
      if (expectedCount <= 0) break;
      continue;
    }
    const countyName = attributeValue(attributes, ["name", "county", "county_name", "namelsad"]);
    if (countyName) nameField = countyName.key;
    result.push({
      name: countyName?.value ?? `Feature ${row + 1}`,
      fieldValue: countyName?.value ?? String(attributes[nameField] ?? `Feature ${row + 1}`),
      zone: ZONES[result.length % ZONES.length],
    });
  }

  if (result.length === 0) throw new Error("No California county attributes could be read.");
  return { nameField, counties: result };
}

function rendererDefinition() {
  return {
    type: "ruleBased",
    defaultStyle: DEFAULT_STYLE,
    rules: counties.map((county) => ({
      field: county.nameField,
      operator: "equals",
      value: county.fieldValue,
      label: `${county.name} - ${county.zone}`,
      enabled: true,
      style: ZONE_STYLES[county.zone],
    })),
  };
}

function updateFeatureList() {
  viewer.setLegendItems(counties.map((county) => ({
    label: `${county.name} - ${county.zone}`,
    enabled: true,
    shape: "polygon",
    style: ZONE_STYLES[county.zone],
  })));
}

function applyRenderer() {
  if (!viewer.setLayerSymbolRenderer(countyLayerIndex, rendererDefinition())) {
    throw new Error("Per-feature county renderer could not be applied.");
  }
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
}

function selectCounty(countyName) {
  const index = counties.findIndex((county) => county.name === countyName);
  if (index < 0) return;
  selectedCountyIndex = index;
  pendingZone = counties[index].zone;
  updatingControls = true;
  viewer.setControlValue(CONTROL.ZONE, pendingZone);
  updatingControls = false;
  viewer.setStatusText(`${counties[index].name} selected. Zone: ${pendingZone}`);
}

function applySelectedZone() {
  const county = counties[selectedCountyIndex];
  if (!county || !pendingZone) return;
  county.zone = pendingZone;
  applyRenderer();
  updateFeatureList();
  viewer.setStatusText(`${county.name} style updated from zone=${county.zone}.`);
}

function onControlChanged(controlId, numericValue, textValue) {
  void numericValue;
  if (updatingControls) return;
  if (controlId === CONTROL.FEATURE) selectCounty(textValue);
  if (controlId === CONTROL.ZONE) pendingZone = textValue;
  if (controlId === CONTROL.APPLY) applySelectedZone();
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
  viewer = new ViewerWindow({ title: "StylePerFeature", width: 1100, height: 760, navigationToolbar: false });
  viewer.addLegendPanel("Feature attributes");
  viewer.setLegendWidth(250);
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
    viewer.addLayer(californiaPath, {
      buildFeatureSource: true,
      applyDefaultStyle: true,
      defaultStyle: DEFAULT_STYLE,
    });
    countyLayerIndex = 0;
    viewer.setLayerName(countyLayerIndex, "California counties - style per feature");
    viewer.setLayerStyle(countyLayerIndex, DEFAULT_STYLE);

    const loaded = loadCountyStates();
    counties = loaded.counties.map((county) => ({ ...county, nameField: loaded.nameField }));
    pendingZone = counties[0].zone;
    applyRenderer();
    updateFeatureList();
    viewer.addControlPanel({
      title: "Selected Feature",
      width: 250,
      controls: [
        { id: CONTROL.FEATURE, type: "combo", label: "Feature", options: counties.map((county) => county.name), value: counties[0].name },
        { id: CONTROL.ZONE, type: "combo", label: "Zone attribute", options: ZONES, value: pendingZone },
        { id: CONTROL.APPLY, type: "button", text: "Apply Feature Style" },
      ],
    }, onControlChanged);
    viewer.processEvents();
    viewer.zoomToLayer(countyLayerIndex);
    viewer.processEvents();
    updatingControls = false;
    viewer.setStatusText("Per-feature style is driven by each county's zone assignment.");
  } catch (error) {
    viewer?.setLegendItems([{ label: "Style-per-feature sample could not be created.", enabled: true, shape: "none" }]);
    viewer?.setStatusText("Style-per-feature sample could not be created.");
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  countyLayerIndex = -1;
  selectedCountyIndex = 0;
  pendingZone = ZONES[0];
  updatingControls = true;
  counties = [];
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
