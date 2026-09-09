"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/output_1m_points.zip";
const COMMAND = Object.freeze({ LOAD: 1, CLEAR: 2 });
const LOAD_OPTIONS = {
  useSpatialIndex: true,
  spatialIndexType: 1,
  buildFeatureSource: true,
  applyDefaultStyle: true,
  defaultStyle: {
    pointColor: "#2D82B7", pointSize: 2.8,
    lineColor: "#1C5D87", lineWidth: 0.8,
  },
};

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let loading = false;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some(fs.existsSync)) {
    throw new Error(`GeoKernel Electron runtime is missing qwindows.dll: ${binDir}`);
  }
}

function timestamp() {
  const now = new Date();
  return now.toLocaleTimeString("en-GB", { hour12: false })
    + `.${String(now.getMilliseconds()).padStart(3, "0")}`;
}

function appendLog(message) {
  viewer?.appendLog(`${timestamp()}  ${message}`);
}

function spatialIndexStateText(state) {
  return ({
    0: "Spatial index idle.",
    1: "Spatial index loading...",
    2: "Spatial locator preparing...",
    3: "Spatial index building...",
    4: "Spatial index ready.",
    5: "Spatial index cancelled.",
    6: "Spatial index failed.",
  })[state] ?? `Spatial index state: ${state}`;
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.BUSY_CHANGED) {
    appendLog(`Event: busyChanged(${event.intValue !== 0})`);
  } else if (event.eventType === ViewerEventType.LAYER_ADDED) {
    appendLog(`Event: layerAdded(index=${event.intValue}, name=${event.text || "<unnamed>"})`);
  } else if (event.eventType === ViewerEventType.LAYERS_CHANGED) {
    appendLog(`Event: layersChanged(count=${viewer?.layerCount() ?? 0})`);
  }
}

async function loadLargeLayer() {
  if (!viewer || loading) return;
  loading = true;
  try {
    viewer.setStatusText("Preparing one million points sample...");
    const samplePath = await ensureSampleFile(
      SAMPLE_URL,
      "output_1m_points.zip",
      "output_1m_points",
      "output_1m_points.shp",
      {
        onDownloadProgress: (percent) => {
          viewer?.setStatusText(percent === null
            ? "Downloading 1M points..."
            : `Downloading 1M points... ${percent}%`);
        },
        onExtracting: () => viewer?.setStatusText("Extracting 1M points..."),
      },
    );
    if (!viewer) return;

    viewer.setStatusText("Loading output_1m_points.shp...");
    appendLog("Action: addLayerFileWithCallbacks(output_1m_points.shp)");
    const started = Date.now();
    viewer.clearLayers();
    const loaded = viewer.addLayerFileWithCallbacks(samplePath, LOAD_OPTIONS, {
      progress: (percent, message) => {
        viewer?.setStatusText(message || `Loading layer... ${percent}%`);
        viewer?.processEvents();
      },
      spatialIndexStateChanged: (state) => {
        viewer?.setStatusText(spatialIndexStateText(state));
        appendLog(`Callback: spatialIndexState=${state}`);
        viewer?.processEvents();
      },
    });
    if (!loaded) throw new Error("Layer load was cancelled.");

    viewer.setLayerName(0, "One Million Points");
    viewer.fullExtent();
    viewer.setStatusText(`Layer loaded in ${Date.now() - started} ms.`);
    appendLog(`Result: loaded in ${Date.now() - started} ms`);
  } catch (error) {
    viewer?.setStatusText(`Layer load failed: ${error.message}`);
    appendLog(`Result: load failed (${error.message})`);
    console.error(error?.stack || error);
  } finally {
    loading = false;
  }
}

async function handleCommand(commandId) {
  if (commandId === COMMAND.LOAD) await loadLargeLayer();
  else if (commandId === COMMAND.CLEAR && viewer && !loading) {
    viewer.clearLayers();
    viewer.setStatusText("Layers cleared.");
    appendLog("Action: clearLayers()");
  }
}

function startEventPump() {
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
  keeperWindow = new BrowserWindow({
    width: 1, height: 1, show: false, skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "BusyCallback", width: 1200, height: 800, navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: COMMAND.LOAD, text: "Load Large Layer" },
    { id: COMMAND.CLEAR, text: "Clear Layers" },
  ], (commandId) => { void handleCommand(commandId); });
  viewer.addLogPanel("Busy and load callback log");
  viewer.setEventCallback(onViewerEvent);
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Ready. Click Load Large Layer to see busy/progress callbacks.");
  appendLog("Sample ready. API: BUSY_CHANGED + layer-load callbacks.");
  viewer.show();
  viewer.processEvents();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
