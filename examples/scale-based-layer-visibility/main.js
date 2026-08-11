"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_BASE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1";
const INITIAL_EXTENT = extent(-151.2, 16.4, -41.6, 55.6);
const LAYER_DEFINITIONS = Object.freeze([
  {
    name: "World", zipName: "world_4326.zip", folder: "world_4326", file: "world_4326.shp",
    style: { fillColor: "#D8E5E1", fillOpacity: 225, lineColor: "#7B918D", lineWidth: 0.8 },
    minScale: 0, maxScale: 11,
  },
  {
    name: "States", zipName: "usa_states.zip", folder: "usa_states", file: "usa_states.shp",
    style: { fillColor: "#A9C8DB", fillOpacity: 135, lineColor: "#356780", lineWidth: 1.1 },
    minScale: 5, maxScale: 45,
  },
  {
    name: "Cities", zipName: "usa_cities.zip", folder: "usa_cities", file: "usa_cities.shp",
    style: { pointColor: "#D95D39", pointSize: 7, lineColor: "#873A24", lineWidth: 1 },
    minScale: 28, maxScale: 0,
  },
]);

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let currentScale = 0;

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

function scaleText(value) {
  if (!(value > 0)) return "-";
  return value < 10 ? value.toFixed(2) : value.toFixed(0);
}

function visibleAtScale(layer) {
  if (!layer.visible) return false;
  const minimum = Number(layer.minVisibleScale ?? 0);
  const maximum = Number(layer.maxVisibleScale ?? 0);
  if (minimum > 0 && currentScale < minimum) return false;
  if (maximum > 0 && currentScale > maximum) return false;
  return true;
}

function refreshUi() {
  if (!viewer) return;
  viewer.setLegendTitle("Scale visibility");
  const items = [
    { label: `Current scale: ${scaleText(currentScale)} px/map unit`, enabled: true, shape: "none" },
    { label: "Visible scale ranges: [min - max]", enabled: true, shape: "none" },
  ];
  for (const layer of viewer.layersInfo()) {
    const name = layer.displayText || layer.name || "Layer";
    const minimum = scaleText(Number(layer.minVisibleScale ?? 0));
    const maximum = scaleText(Number(layer.maxVisibleScale ?? 0));
    items.push({
      label: `${visibleAtScale(layer) ? "[x]" : "[ ]"}  [${minimum} - ${maximum}]  ${name}`,
      enabled: true,
      shape: "none",
    });
  }
  viewer.setLegendItems(items);
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.ZOOM_CHANGED) currentScale = Number(event.doubleValue ?? 0);
  if ([
    ViewerEventType.ZOOM_CHANGED,
    ViewerEventType.VISIBLE_EXTENT_CHANGED,
    ViewerEventType.LAYERS_CHANGED,
    ViewerEventType.LAYER_ADDED,
    ViewerEventType.LAYER_REMOVED,
    ViewerEventType.LAYER_VISIBILITY_CHANGED,
  ].includes(event.eventType)) refreshUi();
}

async function prepareLayer(definition) {
  return ensureSampleFile(
    `${SAMPLE_BASE_URL}/${definition.zipName}`,
    definition.zipName,
    definition.folder,
    definition.file,
  );
}

function addLayer(definition, layerPath) {
  viewer.addLayer(layerPath, {
    applyDefaultStyle: true,
    defaultStyle: definition.style,
  });
  viewer.setLayerName(0, definition.name);
  viewer.setLayerStyle(0, definition.style);
  if (!viewer.setLayerVisibleScaleRange(0, definition.minScale, definition.maxScale)) {
    throw new Error(`Visible scale range could not be set for ${definition.name}.`);
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
      if (Date.now() - viewerHiddenSince > 750) app.quit();
    }
  }, 16);
}

async function start() {
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "ScaleBasedLayerVisibility", width: 1200, height: 800, navigationToolbar: true });
  viewer.addLegendPanel("Scale visibility");
  viewer.setLegendWidth(220);
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.PAN);
  viewer.setLegendItems([{ label: "Preparing sample data...", enabled: true, shape: "none" }]);
  viewer.setStatusText("Preparing sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const paths = [];
    for (const definition of LAYER_DEFINITIONS) paths.push(await prepareLayer(definition));
    if (!viewer) return;
    for (let index = 0; index < LAYER_DEFINITIONS.length; index += 1) {
      addLayer(LAYER_DEFINITIONS[index], paths[index]);
    }
    viewer.refreshLayers();
    viewer.processEvents();
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.processEvents();
    refreshUi();
    viewer.setStatusText("Scale-based layer visibility is ready.");
  } catch (error) {
    viewer?.setStatusText("Scale-based layers could not be loaded.");
    refreshUi();
    throw error;
  }
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  currentScale = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
