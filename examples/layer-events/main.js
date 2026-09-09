"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const {
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");

const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_RELEASE = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1";
const INITIAL_EXTENT = extent(-151.2, 16.4, -41.6, 55.6);
const LAYERS = [
  { name: "World", archive: "world_4326.zip", folder: "world_4326", file: "world_4326.shp",
    style: { fillColor: "#D8E5E1", fillOpacity: 220, lineColor: "#7B918D", lineWidth: 0.8 } },
  { name: "States", archive: "usa_states.zip", folder: "usa_states", file: "usa_states.shp",
    style: { fillColor: "#A9C8DB", fillOpacity: 115, lineColor: "#356780", lineWidth: 1.2 } },
  { name: "Cities", archive: "usa_cities.zip", folder: "usa_cities", file: "usa_cities.shp",
    style: { pointColor: "#D95D39", pointSize: 7 } },
];

const COMMAND = Object.freeze({
  ADD_WORLD: 1,
  ADD_STATES: 2,
  ADD_CITIES: 3,
  REMOVE_SELECTED: 4,
  CLEAR_LAYERS: 5,
  REFRESH: 6,
  CLEAR_LOG: 7,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

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

function timestamp() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false })
    + `.${String(new Date().getMilliseconds()).padStart(3, "0")}`;
}

function appendLog(message) {
  viewer?.appendLog(`${timestamp()}  ${message}`);
}

function layerName(index, fallback = "<none>") {
  if (!viewer || index < 0 || index >= viewer.layerCount()) return fallback;
  return viewer.layerInfo(index).name || viewer.layerDisplayText(index) || fallback;
}

function eventMessage(event) {
  switch (event.eventType) {
    case ViewerEventType.LAYER_ADDING: return `Signal: layerAdding(${event.text})`;
    case ViewerEventType.LAYER_ADDED: return `Signal: layerAdded(${event.text || layerName(event.intValue)})`;
    case ViewerEventType.LAYER_REMOVING: return `Signal: layerRemoving(${event.text || layerName(event.intValue)})`;
    case ViewerEventType.LAYER_REMOVED: return `Signal: layerRemoved(${event.text})`;
    case ViewerEventType.LAYER_VISIBILITY_CHANGED:
      return `Signal: layerVisibilityChanged(${layerName(event.intValue)}, ${event.intValue2 !== 0})`;
    case ViewerEventType.LAYER_EDIT_STATE_CHANGED: return `Signal: layerEditStateChanged(${layerName(event.intValue)})`;
    case ViewerEventType.LAYER_EDIT_SESSION_STARTED: return `Signal: layerEditSessionStarted(${layerName(event.intValue)})`;
    case ViewerEventType.LAYER_EDIT_SESSION_COMMITTED: return `Signal: layerEditSessionCommitted(${layerName(event.intValue)})`;
    case ViewerEventType.LAYER_EDIT_SESSION_ROLLED_BACK: return `Signal: layerEditSessionRolledBack(${layerName(event.intValue)})`;
    case ViewerEventType.LAYER_ORDER_CHANGED: return "Signal: layerOrderChanged()";
    case ViewerEventType.INDEX_CREATING: return `Signal: indexCreating(${event.text})`;
    case ViewerEventType.INDEX_CREATED: return `Signal: indexCreated(${event.text})`;
    case ViewerEventType.INDEX_LOADED: return `Signal: indexLoaded(${event.text})`;
    case ViewerEventType.RENDER_BACKEND_CHANGED:
      return `Signal: renderBackendChanged(${event.text}, hardware=${event.intValue !== 0}, fallback=${event.intValue2 !== 0})`;
    case ViewerEventType.LAYERS_CHANGED: return `Signal: layersChanged(count=${viewer?.layerCount() ?? 0})`;
    default: return null;
  }
}

function onViewerEvent(event) {
  const message = eventMessage(event);
  if (message) appendLog(message);
}

async function prepareLayer(layer) {
  appendLog(`Action: prepareSampleData(${layer.archive})`);
  return ensureSampleFile(
    `${SAMPLE_RELEASE}/${layer.archive}`,
    layer.archive,
    layer.folder,
    layer.file,
  );
}

function findLayerIndex(name) {
  return viewer.layersInfo().findIndex((layer) => layer.name?.toLowerCase() === name.toLowerCase());
}

async function addLayer(layer) {
  if (!viewer || findLayerIndex(layer.name) >= 0) {
    appendLog(`Action skipped: ${layer.name} already exists`);
    return;
  }
  const layerPath = await prepareLayer(layer);
  if (!viewer) return;
  appendLog(`Action: addLayerFromPath(${layerPath})`);
  viewer.addLayer(layerPath);
  viewer.setLayerName(0, layer.name);
  viewer.setLayerStyle(0, layer.style);
  viewer.refreshLayers();
}

async function handleCommand(commandId) {
  if (!viewer) return;
  if (commandId >= COMMAND.ADD_WORLD && commandId <= COMMAND.ADD_CITIES) {
    await addLayer(LAYERS[commandId - 1]);
    return;
  }
  if (commandId === COMMAND.REMOVE_SELECTED) {
    const index = viewer.selectedLayerIndex();
    if (index >= 0) {
      appendLog(`Action: removeLayer(${layerName(index)})`);
      viewer.removeLayer(index);
    }
  } else if (commandId === COMMAND.CLEAR_LAYERS) {
    appendLog("Action: clearLayers()");
    viewer.clearLayers();
  } else if (commandId === COMMAND.REFRESH) {
    appendLog("Action: refreshLayers()");
    viewer.refreshLayers();
  } else if (commandId === COMMAND.CLEAR_LOG) {
    viewer.clearLog();
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
  viewer = new ViewerWindow({
    title: "LayerEvents",
    width: 1280,
    height: 820,
    navigationToolbar: false,
    layerPanel: { allowReorder: true, allowVisibility: true },
  });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_WORLD, text: "Add World" },
    { id: COMMAND.ADD_STATES, text: "Add States" },
    { id: COMMAND.ADD_CITIES, text: "Add Cities" },
    { id: COMMAND.REMOVE_SELECTED, text: "Remove Selected", separatorBefore: true },
    { id: COMMAND.CLEAR_LAYERS, text: "Clear Layers" },
    { id: COMMAND.REFRESH, text: "Refresh" },
    { id: COMMAND.CLEAR_LOG, text: "Clear Log", separatorBefore: true },
  ], (commandId) => { void handleCommand(commandId).catch(console.error); });
  viewer.addLogPanel("Layer event log");
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();

  for (const layer of LAYERS) await addLayer(layer);
  if (viewer) viewer.setViewExtent(INITIAL_EXTENT);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
