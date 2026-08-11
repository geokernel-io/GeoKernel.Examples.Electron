"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_8km_tif.zip";
const WORKING_DIRECTORY = path.join(__dirname, "RasterOverviewData");
const WORKING_RASTER = path.join(WORKING_DIRECTORY, "world_8km_overview_test.tif");
const OVERVIEW_FILE = `${WORKING_RASTER}.ovr`;

const COMMAND = Object.freeze({
  LOAD_WITHOUT: 1,
  LOAD_WITH: 2,
  BENCHMARK: 3,
  RESET: 4,
  FULL_EXTENT: 5,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let sourceRaster = "";
let currentMode = "Reset";
let loadElapsedMs = 0;
let lastBenchmark = null;
let withoutOverviewBenchmark = null;
let withOverviewBenchmark = null;

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

function fileSize(filePath) {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function factorText(values) {
  return Array.isArray(values) && values.length ? values.join(", ") : "-";
}

function overviewDimensions(diagnostics) {
  const values = diagnostics?.overviews;
  return Array.isArray(values) && values.length
    ? values.map((item) => `${item.width}x${item.height}`).join(", ")
    : "-";
}

function benchmarkText(benchmark) {
  if (!benchmark) return "Run Downsample Benchmark after loading a raster.";
  if (!benchmark.valid) return `Benchmark failed: ${benchmark.errorMessage || "unknown"}`;
  return `${currentMode} zoomed-out benchmark: ${benchmark.passes} reads to ${benchmark.targetWidth}x${benchmark.targetHeight}, selected overview=${benchmark.selectedOverview}, elapsed=${benchmark.elapsedMs} ms`;
}

function comparisonText() {
  if (!withoutOverviewBenchmark?.valid || !withOverviewBenchmark?.valid) return "";
  const withoutMs = Number(withoutOverviewBenchmark.elapsedMs || 0);
  const withMs = Number(withOverviewBenchmark.elapsedMs || 0);
  if (withoutMs <= 0) return "";
  const savedMs = withoutMs - withMs;
  if (savedMs <= 0) {
    return `Comparison: overview did not win on this run (${withoutMs} ms without, ${withMs} ms with). This can happen on small rasters or warm OS cache.`;
  }
  return `Comparison: overview saved ${savedMs} ms (${((savedMs / withoutMs) * 100).toFixed(1)}% faster) for this zoomed-out read (${withoutMs} ms without, ${withMs} ms with).`;
}

function detailsText(diagnostics = {}) {
  const hasDiagnostics = Object.keys(diagnostics).length > 0;
  const lines = [
    "RasterOverview sample",
    "",
    `Load mode: ${currentMode}`,
    `Load elapsed: ${loadElapsedMs} ms`,
    `Working raster: ${WORKING_RASTER}`,
    `Raster file size: ${fileSize(WORKING_RASTER)} bytes`,
    `Overview file: ${OVERVIEW_FILE}`,
    `Overview file exists: ${fs.existsSync(OVERVIEW_FILE) ? "yes" : "no"}`,
    `Overview file size: ${fileSize(OVERVIEW_FILE)} bytes`,
    "",
  ];
  if (hasDiagnostics) {
    lines.push(
      "Raster metadata",
      `Driver: ${diagnostics.driverName || "unknown"}`,
      `Size: ${diagnostics.width || 0} x ${diagnostics.height || 0} px`,
      `Pixels: ${Number(diagnostics.width || 0) * Number(diagnostics.height || 0)}`,
      `Bands: ${diagnostics.bandCount || 0}`,
      `EPSG: ${diagnostics.epsgCode || "unknown"}`,
      "",
      "Provider overview state",
      `Provider overview path: ${diagnostics.overviewFilePath || ""}`,
      `Recommended pyramid ready: ${diagnostics.recommendedPyramidReady ? "yes" : "no"}`,
      `Overview count: ${Array.isArray(diagnostics.overviews) ? diagnostics.overviews.length : 0}`,
      `Overview dimensions: ${overviewDimensions(diagnostics)}`,
      `Overview factors: ${factorText(diagnostics.overviewFactors)}`,
      `Recommended factors: ${factorText(diagnostics.recommendedOverviewFactors)}`,
      "",
    );
  } else {
    lines.push("No raster layer loaded.", "");
  }
  lines.push(
    "LayerLoadOptions knobs",
    "prepareRasterOverviews = true/false",
    "rasterOverviewMinimumPixels = threshold",
    "rasterOverviewResampling = AVERAGE",
    "",
    "Why overviews matter",
    "- Without overview, GDAL reads full-resolution raster data.",
    "- With overview, GDAL can read a smaller pyramid level.",
    "- selectedOverview=-1 means no pyramid level was used.",
    "- selectedOverview>=0 means a pyramid level was used.",
    "",
    "Benchmark",
    benchmarkText(lastBenchmark),
  );
  const comparison = comparisonText();
  if (comparison) lines.push(comparison);
  return lines.join("\n");
}

function updateDetails(diagnostics = null) {
  if (!viewer) return;
  let value = diagnostics;
  if (!value && viewer.layerCount() > 0) value = viewer.rasterOverviewDiagnostics(0, false);
  viewer.clearLog();
  viewer.appendLog(detailsText(value || {}));
}

function resetWorkingCopy() {
  if (!sourceRaster) return;
  viewer.clearLayers();
  fs.mkdirSync(WORKING_DIRECTORY, { recursive: true });
  if (fs.existsSync(WORKING_RASTER)) fs.rmSync(WORKING_RASTER);
  if (fs.existsSync(OVERVIEW_FILE)) fs.rmSync(OVERVIEW_FILE);
  fs.copyFileSync(sourceRaster, WORKING_RASTER);
  currentMode = "Reset";
  loadElapsedMs = 0;
  lastBenchmark = null;
  withoutOverviewBenchmark = null;
  withOverviewBenchmark = null;
  updateDetails({});
  viewer.setStatusText("Working copy reset. Overview file removed.");
}

function loadRaster(prepareOverview) {
  if (!fs.existsSync(WORKING_RASTER)) resetWorkingCopy();
  const mode = prepareOverview ? "Load With Overview" : "Load Without Overview";
  viewer.clearLayers();
  viewer.setStatusText(`${mode}...`);
  viewer.processEvents();
  const started = performance.now();
  viewer.addLayer(WORKING_RASTER, {
    prepareRasterOverviews: prepareOverview,
    rasterOverviewMinimumPixels: prepareOverview ? 0 : Number.MAX_SAFE_INTEGER,
    rasterOverviewResampling: "AVERAGE",
  });
  loadElapsedMs = Math.round(performance.now() - started);
  currentMode = mode;
  lastBenchmark = null;
  viewer.setLayerName(0, prepareOverview ? "GeoTIFF - Overview" : "GeoTIFF - No Overview");
  viewer.zoomToLayer(0);
  updateDetails();
  viewer.setStatusText(`${mode} finished in ${loadElapsedMs} ms.`);
}

function runBenchmark() {
  if (viewer.layerCount() === 0) {
    viewer.setStatusText("Load a raster first.");
    return;
  }
  viewer.setStatusText("Running downsample benchmark...");
  viewer.processEvents();
  const diagnostics = viewer.rasterOverviewDiagnostics(0, true);
  lastBenchmark = diagnostics.benchmark || null;
  if (currentMode === "Load Without Overview") withoutOverviewBenchmark = lastBenchmark;
  if (currentMode === "Load With Overview") withOverviewBenchmark = lastBenchmark;
  updateDetails(diagnostics);
  viewer.setStatusText(comparisonText() || benchmarkText(lastBenchmark));
}

function onCommand(commandId) {
  try {
    if (commandId === COMMAND.LOAD_WITHOUT) loadRaster(false);
    else if (commandId === COMMAND.LOAD_WITH) loadRaster(true);
    else if (commandId === COMMAND.BENCHMARK) runBenchmark();
    else if (commandId === COMMAND.RESET) resetWorkingCopy();
    else if (commandId === COMMAND.FULL_EXTENT && viewer.layerCount() > 0) viewer.zoomToLayer(0);
  } catch (error) {
    viewer.setStatusText(`RasterOverview failed: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "RasterOverview", width: 1200, height: 800, navigationToolbar: true });
  viewer.addCommandToolbar([
    { id: COMMAND.LOAD_WITHOUT, text: "Load Without Overview" },
    { id: COMMAND.LOAD_WITH, text: "Load With Overview" },
    { id: COMMAND.BENCHMARK, text: "Run Downsample Benchmark" },
    { id: COMMAND.RESET, text: "Reset Working Copy" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLogPanel("Raster overview details");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing GeoTIFF sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  sourceRaster = await ensureSampleFile(SAMPLE_URL, "world_8km_tif.zip", "world_8km_tif", "world_8km.tif");
  if (!viewer || closing) return;
  resetWorkingCopy();
  loadRaster(false);
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
