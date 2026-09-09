"use strict";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow, dialog } = require("electron");
const { ViewerTool, ViewerWindow } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const RASTER_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/bilbao_s2_rgbnir_2021.zip";
const MODEL_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/landcover-bilbao-model.zip";
const COLORS = [
  { code: 10, red: 0, green: 100, blue: 0 }, { code: 20, red: 255, green: 187, blue: 34 },
  { code: 30, red: 255, green: 255, blue: 76 }, { code: 40, red: 240, green: 150, blue: 255 },
  { code: 50, red: 250, green: 0, blue: 0 }, { code: 60, red: 180, green: 180, blue: 180 },
  { code: 70, red: 240, green: 240, blue: 240 }, { code: 80, red: 0, green: 100, blue: 200 },
  { code: 90, red: 0, green: 150, blue: 160 }, { code: 95, red: 0, green: 207, blue: 117 },
  { code: 100, red: 250, green: 230, blue: 160 },
];
const CONTROL = { MODEL: 1, MODEL_BROWSE: 2, RASTER: 3, RASTER_BROWSE: 4, OUTPUT: 5, OUTPUT_BROWSE: 6, PROVIDER: 7, RUN: 8, PROGRESS: 9, STAGE: 10, OPACITY: 11 };

let viewer = null; let keeper = null; let worker = null; let eventPump = null;
let visibleOnce = false; let hiddenSince = 0; let closing = false; let busy = false; let sequence = 0;
let modelPath = ""; let rasterPath = ""; let outputPath = ""; let provider = "auto";
let predictionLayerIndex = -1; let predictionOpacity = 50;

function outputFor(value) {
  const parsed = path.parse(value); const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const outputDir = path.join(__dirname, "outputs"); fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, `${parsed.name}_landcover_mask_${stamp}.tif`);
}
function previewFor(value) { const parsed = path.parse(value); return path.join(parsed.dir, `${parsed.name}_preview.tif`); }

function setProgress(value, text) {
  if (!viewer) return;
  const bounded = Math.max(0, Math.min(100, Math.round(value || 0)));
  viewer.setControlValue(CONTROL.PROGRESS, bounded); viewer.setControlValue(CONTROL.STAGE, text);
  viewer.setStatusText(`${bounded}% — ${text}`);
}

function setRunning(value) {
  busy = value; if (!viewer) return;
  viewer.setControlEnabled(CONTROL.RUN, !value);
  for (const id of [CONTROL.MODEL_BROWSE, CONTROL.RASTER_BROWSE, CONTROL.OUTPUT_BROWSE, CONTROL.PROVIDER]) viewer.setControlEnabled(id, !value);
}

function request() {
  return {
    modelPackagePath: modelPath, rasterPath, outputPath, previewOutputPath: previewFor(outputPath),
    applyManifestClassCodes: true, classPalette: COLORS, bands: [1, 2, 3, 4],
    provider, outputMode: "classMask",
  };
}

function diagnostics(result, preview) {
  return [
    "GeoKernel AI land-cover inference", "", `Provider: ${result.provider || ""}`,
    `Raster: ${result.width || 0} x ${result.height || 0}`, `Tiles: ${result.processedTiles || 0}`,
    `Elapsed: ${result.elapsedMilliseconds || 0} ms`, "", "Class mask:", outputPath,
    "", "Color preview:", preview, "", "ESA WorldCover classes",
    "● Tree cover   ● Shrubland   ● Grassland", "● Cropland   ● Built-up   ● Bare / sparse", "● Permanent water",
  ].join("\n");
}

function run() {
  if (!viewer || busy) return;
  if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isDirectory() || !fs.existsSync(rasterPath)) {
    dialog.showMessageBox({ type: "warning", title: "LandCoverInference", message: "Select an existing model package and input raster." }); return;
  }
  if (!outputPath.trim()) { dialog.showMessageBox({ type: "warning", title: "LandCoverInference", message: "Select a class-mask output path." }); return; }
  setRunning(true); setProgress(0, "Opening model package..."); viewer.clearLog();
  viewer.appendLog("Validating the model package and preparing tiled inference...");
  worker.send({ type: "infer", id: ++sequence, request: request() });
}

function workerMessage(message) {
  if (!viewer || message.id !== sequence) return;
  if (message.type === "progress") {
    setProgress(message.progress?.percent || 0, message.progress?.message || "Running tiled inference..."); return;
  }
  if (message.type === "error") { fail(message.message); return; }
  if (message.type !== "result") return;
  try {
    const preview = previewFor(outputPath); setProgress(95, "Opening color preview...");
    viewer.removeLayerByName("Land-cover prediction"); viewer.addLayerFile(preview);
    predictionLayerIndex = 0; viewer.setLayerName(predictionLayerIndex, "Land-cover prediction");
    viewer.setLayerOpacity(predictionLayerIndex, predictionOpacity / 100.0);
    viewer.refreshLayers(); viewer.clearLog(); viewer.appendLog(diagnostics(message.result, preview));
    setRunning(false); setProgress(100, "Inference complete");
    viewer.setStatusText(`Land-cover mask created in ${message.result.elapsedMilliseconds || 0} ms.`);
  } catch (error) { fail(error?.message || String(error)); }
}

function fail(message) {
  setRunning(false); setProgress(0, "Inference failed"); viewer?.clearLog(); viewer?.appendLog(`Inference failed:\n${message}`);
  dialog.showMessageBox({ type: "error", title: "LandCoverInference", message: String(message) });
}

async function browseModel() {
  const result = await dialog.showOpenDialog({ title: "Select GeoKernel model package", defaultPath: modelPath || undefined, properties: ["openDirectory"] });
  if (!result.canceled && result.filePaths[0]) { modelPath = result.filePaths[0]; viewer?.setControlValue(CONTROL.MODEL, modelPath); }
}
async function browseRaster() {
  const result = await dialog.showOpenDialog({ title: "Select input raster", defaultPath: rasterPath || undefined, properties: ["openFile"], filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
  if (!result.canceled && result.filePaths[0]) { rasterPath = result.filePaths[0]; outputPath = outputFor(rasterPath); viewer?.setControlValue(CONTROL.RASTER, rasterPath); viewer?.setControlValue(CONTROL.OUTPUT, outputPath); openBaseRaster(); }
}
async function browseOutput() {
  const result = await dialog.showSaveDialog({ title: "Save class mask", defaultPath: outputPath || undefined, filters: [{ name: "GeoTIFF", extensions: ["tif"] }] });
  if (!result.canceled && result.filePath) { outputPath = result.filePath; viewer?.setControlValue(CONTROL.OUTPUT, outputPath); }
}

function controlChanged(id, numericValue, textValue) {
  if (id === CONTROL.MODEL) modelPath = textValue || "";
  else if (id === CONTROL.RASTER) rasterPath = textValue || "";
  else if (id === CONTROL.OUTPUT) outputPath = textValue || "";
  else if (id === CONTROL.PROVIDER) provider = String(textValue || "auto").toLowerCase();
  else if (id === CONTROL.OPACITY) {
    predictionOpacity = Math.max(0, Math.min(100, Number(numericValue)));
    if (predictionLayerIndex >= 0) { viewer.setLayerOpacity(predictionLayerIndex, predictionOpacity / 100.0); viewer.refreshLayers(); }
  }
  else if (id === CONTROL.MODEL_BROWSE) setImmediate(browseModel);
  else if (id === CONTROL.RASTER_BROWSE) setImmediate(browseRaster);
  else if (id === CONTROL.OUTPUT_BROWSE) setImmediate(browseOutput);
  else if (id === CONTROL.RUN) setImmediate(run);
}

function openBaseRaster() {
  predictionLayerIndex = -1;
  viewer.clearLayers(); viewer.addLayerFile(rasterPath); viewer.setLayerName(0, "Bilbao RGBNIR raster");
  viewer.refreshLayers(); viewer.fullExtent();
}

async function prepareSamples() {
  try {
    setProgress(5, "Preparing Bilbao sample data...");
    rasterPath = await ensureSampleFile(RASTER_URL, "bilbao_s2_rgbnir_2021.zip", "bilbao_s2_rgbnir_2021", "bilbao_s2_rgbnir_2021.tif");
    const manifest = await ensureSampleFile(MODEL_URL, "landcover-bilbao-model.zip", "landcover-bilbao-model", "geokernel-model.json");
    modelPath = path.dirname(manifest); outputPath = outputFor(rasterPath);
    viewer.setControlValue(CONTROL.MODEL, modelPath); viewer.setControlValue(CONTROL.RASTER, rasterPath); viewer.setControlValue(CONTROL.OUTPUT, outputPath);
    openBaseRaster(); viewer.clearLog(); viewer.appendLog("Bilbao input raster is open. Run land-cover inference to add the prediction layer.");
    setProgress(0, "Ready");
  } catch (error) { fail(error?.message || String(error)); }
}

function startPump() {
  eventPump = setInterval(() => {
    if (!viewer) return; viewer.processEvents();
    if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; }
    else if (visibleOnce) { if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 750) app.quit(); }
  }, 16);
}

async function start() {
  closing = false;
  keeper = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "LandCoverInference", width: 1280, height: 820, navigationToolbar: true });
  viewer.addControlPanel({ title: "Land-cover inference", area: "right", width: 420, controls: [
    { id: CONTROL.MODEL, type: "text", label: "Model package", value: modelPath },
    { id: CONTROL.MODEL_BROWSE, type: "button", text: "Browse model package..." },
    { id: CONTROL.RASTER, type: "text", label: "Input raster", value: rasterPath },
    { id: CONTROL.RASTER_BROWSE, type: "button", text: "Browse input raster..." },
    { id: CONTROL.OUTPUT, type: "text", label: "Class mask", value: outputPath },
    { id: CONTROL.OUTPUT_BROWSE, type: "button", text: "Browse class mask..." },
    { id: CONTROL.PROVIDER, type: "combo", label: "Execution provider", options: ["Auto", "CPU", "CUDA", "DirectML"], value: "Auto" },
    { id: CONTROL.OPACITY, type: "number", label: "Prediction opacity", value: 50, minimum: 0, maximum: 100, step: 5, decimals: 0, suffix: "%" },
    { id: CONTROL.RUN, type: "button", text: "Run land-cover inference" },
    { id: CONTROL.PROGRESS, type: "progress", label: "Progress", value: 0, textVisible: true, format: "%p%" },
    { id: CONTROL.STAGE, type: "text", label: "Stage", value: "Ready.", readOnly: true },
  ] }, controlChanged);
  viewer.addLogPanel("Inference diagnostics"); viewer.appendLog("Select a model package and an input raster.");
  viewer.setTool(ViewerTool.PAN);
  viewer.show(); viewer.processEvents(); startPump();
  worker = fork(path.join(__dirname, "inference-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data));
  worker.on("message", workerMessage); worker.on("error", (error) => fail(error.message));
  worker.on("exit", (code, signal) => { if (!closing && busy) fail(`Inference worker stopped unexpectedly (${signal || `exit ${code}`}).`); });
  setImmediate(prepareSamples);
}

function stop() {
  closing = true; if (eventPump) clearInterval(eventPump); eventPump = null;
  worker?.kill(); worker = null; if (viewer) try { viewer.close(); } catch {} viewer = null;
  keeper?.destroy(); keeper = null;
}

module.exports = { start, stop };
