"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_8km_tif.zip";

const COMMAND = Object.freeze({
  LOAD_DISABLED: 1,
  LOAD_SMALL: 2,
  LOAD_LARGE: 3,
  BENCHMARK: 4,
  CLEAR_CACHE: 5,
  FULL_EXTENT: 6,
});

const MODE = Object.freeze({
  DISABLED: "Cache Disabled",
  SMALL: "Small Cache Budget",
  LARGE: "Large Cache Budget",
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let rasterPath = "";
let currentMode = "No Raster Loaded";
let lastBenchmark = null;

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

function valueOf(source, name, fallback = "-") {
  const value = source?.[name];
  return value === undefined || value === null ? fallback : value;
}

function benchmarkText(benchmark) {
  if (!benchmark) return "Benchmark has not run.";
  if (benchmark.valid === false) return `Benchmark failed: ${benchmark.errorMessage || "unknown error"}`;

  const firstMs = Number(valueOf(benchmark, "firstPassMs", 0));
  const secondMs = Number(valueOf(benchmark, "secondPassMs", 0));
  const savedMs = firstMs - secondMs;
  const percent = firstMs > 0 ? ((savedMs / firstMs) * 100).toFixed(1) : "0.0";
  return [
    "Benchmark",
    `Tiles read per pass: ${valueOf(benchmark, "tileCount")}`,
    `First pass: ${firstMs} ms, cache hits=${valueOf(benchmark, "firstPassHits")}, overview=${valueOf(benchmark, "firstPassOverviewLevel")}`,
    `Second pass: ${secondMs} ms, cache hits=${valueOf(benchmark, "secondPassHits")}, overview=${valueOf(benchmark, "secondPassOverviewLevel")}`,
    `Second pass delta: ${savedMs} ms (${percent}%)`,
    "",
    "How to read this",
    "- First pass fills the memory tile cache.",
    "- Second pass requests the same tiles again.",
    "- With a large budget, second-pass cache hits should equal tile count.",
    "- With cache disabled, second-pass hits stay at 0.",
    "- With a tiny budget, only the last few tiles survive in cache.",
  ].join("\n");
}

function detailsText(diagnostics = {}) {
  const hasRaster = viewer?.layerCount() > 0;
  const lines = [
    "RasterTileCache sample",
    "",
    `Load mode: ${currentMode}`,
    `Source: ${rasterPath}`,
    "",
  ];
  if (!hasRaster) {
    lines.push("No raster layer loaded.");
    return lines.join("\n");
  }
  lines.push(
    "Raster metadata",
    `Driver: ${valueOf(diagnostics, "driverName")}`,
    `Size: ${valueOf(diagnostics, "width")} x ${valueOf(diagnostics, "height")} px`,
    `Bands: ${valueOf(diagnostics, "bandCount")}`,
    `Overview count: ${valueOf(diagnostics, "overviewCount")}`,
    "",
    "Cache stats",
    `Enabled: ${valueOf(diagnostics, "enabled")}`,
    `Items: ${valueOf(diagnostics, "itemCount")}`,
    `Used pixel cost: ${valueOf(diagnostics, "usedPixelCost")}`,
    `Max pixel cost: ${valueOf(diagnostics, "maxPixelCost")}`,
    `Max item pixel cost: ${valueOf(diagnostics, "maxItemPixelCost")}`,
    "",
    "LayerLoadOptions knobs",
    "rasterTileCacheEnabled",
    "rasterTileCachePixelBudget",
    "rasterTileCacheMaximumItemPixels",
    "",
    benchmarkText(lastBenchmark),
  );
  return lines.join("\n");
}

function updateDetails(diagnostics = null) {
  let value = diagnostics;
  if (!value && viewer.layerCount() > 0) value = viewer.rasterTileCacheDiagnostics(0, false, false);
  viewer.clearLog();
  viewer.appendLog(detailsText(value || {}));
}

function optionsFor(mode) {
  const options = {
    prepareRasterOverviews: true,
    rasterOverviewMinimumPixels: 0,
    rasterTileCacheEnabled: mode !== MODE.DISABLED,
    rasterTileCachePixelBudget: 0,
    rasterTileCacheMaximumItemPixels: 0,
  };
  if (mode === MODE.SMALL) {
    options.rasterTileCachePixelBudget = 128 * 1024;
    options.rasterTileCacheMaximumItemPixels = 128 * 1024;
  } else if (mode === MODE.LARGE) {
    options.rasterTileCachePixelBudget = 4 * 1024 * 1024;
    options.rasterTileCacheMaximumItemPixels = 512 * 512;
  }
  return options;
}

function loadRaster(mode) {
  viewer.clearLayers();
  currentMode = mode;
  lastBenchmark = null;
  viewer.setStatusText(`Loading ${mode}...`);
  viewer.processEvents();
  viewer.addLayer(rasterPath, optionsFor(mode));
  const layerIndex = viewer.layerCount() - 1;
  if (layerIndex < 0) throw new Error(`Raster could not be loaded: ${rasterPath}`);
  viewer.setLayerName(layerIndex, mode);
  viewer.zoomToLayer(layerIndex);
  updateDetails();
  viewer.setStatusText(`${mode} loaded.`);
}

function runBenchmark() {
  if (viewer.layerCount() === 0) {
    viewer.setStatusText("Load a raster first.");
    return;
  }
  viewer.setStatusText("Running tile cache benchmark...");
  viewer.processEvents();
  const diagnostics = viewer.rasterTileCacheDiagnostics(0, true, false);
  lastBenchmark = diagnostics.benchmark || null;
  updateDetails(diagnostics);
  viewer.setStatusText(lastBenchmark
    ? `Second pass: ${valueOf(lastBenchmark, "secondPassMs")} ms, cache hits=${valueOf(lastBenchmark, "secondPassHits")}.`
    : "Benchmark failed.");
}

function clearCache() {
  if (viewer.layerCount() === 0) {
    viewer.setStatusText("Load a raster first.");
    return;
  }
  const diagnostics = viewer.rasterTileCacheDiagnostics(0, false, true);
  lastBenchmark = null;
  updateDetails(diagnostics);
  viewer.setStatusText("Memory tile cache cleared.");
}

function onCommand(commandId) {
  setImmediate(() => executeCommand(commandId));
}

function executeCommand(commandId) {
  if (!viewer || closing) return;
  try {
    if (commandId === COMMAND.LOAD_DISABLED) loadRaster(MODE.DISABLED);
    else if (commandId === COMMAND.LOAD_SMALL) loadRaster(MODE.SMALL);
    else if (commandId === COMMAND.LOAD_LARGE) loadRaster(MODE.LARGE);
    else if (commandId === COMMAND.BENCHMARK) runBenchmark();
    else if (commandId === COMMAND.CLEAR_CACHE) clearCache();
    else if (commandId === COMMAND.FULL_EXTENT) viewer.fullExtent();
  } catch (error) {
    viewer.setStatusText(`RasterTileCache failed: ${error.message}`);
    viewer.clearLog();
    viewer.appendLog(`${detailsText({})}\n\nError\n${error.stack || error.message}`);
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
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
}

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "RasterTileCache", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.LOAD_DISABLED, text: "Load Cache Disabled" },
    { id: COMMAND.LOAD_SMALL, text: "Load Small Budget" },
    { id: COMMAND.LOAD_LARGE, text: "Load Large Budget" },
    { id: COMMAND.BENCHMARK, text: "Run Tile Benchmark" },
    { id: COMMAND.CLEAR_CACHE, text: "Clear Tile Cache" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLogPanel("Cache configuration");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing GeoTIFF sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  rasterPath = await ensureSampleFile(SAMPLE_URL, "world_8km_tif.zip", "world_8km_tif", "world_8km.tif");
  if (!viewer || closing) return;
  loadRaster(MODE.LARGE);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) {
    try { viewer.close(); } catch { /* Native window may already be destroyed. */ }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
