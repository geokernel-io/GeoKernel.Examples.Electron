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

const PRESETS = Object.freeze([
  ["Bing Virtual Earth", "http://ecn.t3.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1"],
  ["CartoDb Dark Matter", "http://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
  ["CartoDb Dark Matter (No Labels)", "http://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png"],
  ["CartoDb Positron", "http://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
  ["CartoDb Positron (No Labels)", "http://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"],
  ["Esri Boundaries Places", "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Gray (dark)", "http://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Gray (light)", "http://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Hillshade", "http://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"],
  ["Esri National Geographic", "http://services.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Navigation Charts", "http://services.arcgisonline.com/ArcGIS/rest/services/Specialty/World_Navigation_Charts/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Ocean", "https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Physical Map", "https://services.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Satellite", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Shaded Relief", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Standard", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Topo World", "http://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"],
  ["Esri Transportation", "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
  ["Google Maps", "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"],
  ["Google Satellite", "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"],
  ["Google Satellite Hybrid", "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"],
  ["Google Terrain", "https://mt1.google.com/vt/lyrs=t&x={x}&y={y}&z={z}"],
  ["Google Terrain Hybrid", "https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}"],
  ["Mapzen Global Terrain", "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  ["Gempa", "https://demo.gempa.de/gaps/tiles/{z}/{y}/{x}"],
  ["OpenStreetMap", "https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
  ["OpenTopoMap", "https://tile.opentopomap.org/{z}/{x}/{y}.png"],
].map(([name, urlTemplate]) => Object.freeze({
  name,
  urlTemplate,
  cacheKey: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  attribution: "",
})));
const DEFAULT_EXTENT_3857 = extent(-1400000, 4100000, 4200000, 7800000);
const CONTROL = Object.freeze({ PRESET: 1, CACHE: 2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
const DEFAULT_PRESET_NAME = "OpenStreetMap";
let selectedPresetName = DEFAULT_PRESET_NAME;
let cacheEnabled = true;
let closing = false;
let activeLayerIndex = -1;
let reloadTimer = null;

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

function selectedPreset() {
  return PRESETS.find((preset) => preset.name === selectedPresetName) ?? PRESETS[0];
}

function presetDetails(preset) {
  return [
    "XYZ preset layer",
    "",
    `Preset count: ${PRESETS.length}`,
    `Selected: ${preset.name}`,
    "",
    "URL template:",
    preset.urlTemplate,
    "",
    `Min zoom: ${preset.minZoom}`,
    `Max zoom: ${preset.maxZoom}`,
    `Tile size: ${preset.tileSize}`,
    `Local cache: ${cacheEnabled ? "enabled" : "disabled"}`,
    "",
    "Attribution:",
    preset.attribution,
    "",
    "The sample creates the layer from:",
    "PRESETS",
    "viewer.addXyzLayer({ name, urlTemplate, minZoom, maxZoom, tileSize, attribution })",
  ].join("\n");
}

function reloadPreset() {
  if (!viewer) return;
  const preset = selectedPreset();
  const cacheDirectory = path.join(
    __dirname, "..", "..", "outputs", "cache", "xyz-presets", preset.cacheKey,
  );
  if (cacheEnabled) fs.mkdirSync(cacheDirectory, { recursive: true });

  viewer.clearLayers();
  activeLayerIndex = viewer.addXyzLayer({
    ...preset,
    localCacheEnabled: cacheEnabled,
    cacheDirectory: cacheEnabled ? cacheDirectory : "",
  });
  if (!Number.isInteger(activeLayerIndex) || activeLayerIndex < 0) {
    throw new Error(`XYZ preset could not be created: ${preset.name}`);
  }
  viewer.setViewExtent(DEFAULT_EXTENT_3857);
  viewer.clearLog();
  viewer.appendLog(presetDetails(preset));
  viewer.setStatusText(`XYZ preset loaded: ${preset.name}`);
}

function schedulePresetReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (!viewer || closing) return;
    try {
      reloadPreset();
    } catch (error) {
      viewer.setStatusText(`XYZ preset failed: ${error.message}`);
      viewer.clearLog();
      viewer.appendLog(`XYZ preset could not be loaded:\n${error.stack || error.message}`);
    }
  }, 50);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (controlId === CONTROL.PRESET) {
    selectedPresetName = textValue || PRESETS[Math.round(numericValue)]?.name || PRESETS[0].name;
  } else if (controlId === CONTROL.CACHE) {
    cacheEnabled = (textValue || "Enabled") === "Enabled";
  } else {
    return;
  }
  schedulePresetReload();
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
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
  if (viewer) {
    try {
      viewer.clearLayers();
      viewer.processEvents();
      viewer.close();
    } catch {
      // The native window may already have been destroyed by the user.
    }
  }
  viewer = null;
  activeLayerIndex = -1;
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
    title: "XyzPresets",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "XYZ presets",
    area: "left",
    width: 285,
    controls: [
      {
        id: CONTROL.PRESET,
        type: "combo",
        label: "Preset",
        options: PRESETS.map((preset) => preset.name),
        value: selectedPresetName,
      },
      {
        id: CONTROL.CACHE,
        type: "combo",
        label: "Local cache",
        options: ["Enabled", "Disabled"],
        value: "Enabled",
      },
    ],
  }, onControlChanged);
  viewer.addLogPanel("XYZ preset details");
  viewer.setTool(ViewerTool.PAN);
  reloadPreset();
  viewer.show();
  viewer.processEvents();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  selectedPresetName = DEFAULT_PRESET_NAME;
  cacheEnabled = true;
  closing = true;
  activeLayerIndex = -1;
  if (viewer) {
    try {
      viewer.clearLayers();
      viewer.processEvents();
      viewer.close();
    } catch {
      // The native window can already be closed during application shutdown.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
