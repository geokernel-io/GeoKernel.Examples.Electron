"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const { AnalysisExecutor, ViewerEventType, ViewerTool, ViewerWindow } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const RASTER_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/buildings.zip";
const MODEL_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/buildings-model.zip";
const CONTROL = { MODEL: 1, MODEL_BROWSE: 2, RASTER: 3, RASTER_BROWSE: 4, LABELS: 5, LABELS_BROWSE: 6, PROVIDER: 7, RUN: 8, PROGRESS: 9, STAGE: 10 };

let viewer = null; let keeper = null; let eventPump = null; let analysis = null; let predictionLayer = null;
let visibleOnce = false; let hiddenSince = 0; let busy = false; let closing = false;
let modelPath = ""; let rasterPath = ""; let labelPath = ""; let provider = "Auto";

function labelsFor(value) { const parsed = path.parse(value); return path.join(parsed.dir, `${parsed.name}_building_instances.tif`); }
function setProgress(value, text) {
  if (!viewer) return; const bounded = Math.max(0, Math.min(100, Math.round(value || 0)));
  viewer.setControlValue(CONTROL.PROGRESS, bounded); viewer.setControlValue(CONTROL.STAGE, text); viewer.setStatusText(`${bounded}% — ${text}`);
}
function setRunning(value) {
  busy = value; if (!viewer) return; viewer.setControlEnabled(CONTROL.RUN, !value);
  for (const id of [CONTROL.MODEL_BROWSE, CONTROL.RASTER_BROWSE, CONTROL.LABELS_BROWSE, CONTROL.PROVIDER]) viewer.setControlEnabled(id, !value);
}
function diagnostics(result) {
  return ["GeoKernel AI building segmentation inference", "", `Provider: ${provider}`,
    `Building polygons: ${Number(result.materializedCount || 0)}`, "", "Instance labels:", labelPath,
    "", "Vector output: in-memory layer"].join("\n");
}

async function run() {
  if (!viewer || busy) return;
  if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isDirectory() || !fs.existsSync(rasterPath)) {
    await dialog.showMessageBox({ type: "warning", title: "BuildingSegmentationInference", message: "Select an existing model package and input raster." }); return;
  }
  if (!labelPath.trim()) { await dialog.showMessageBox({ type: "warning", title: "BuildingSegmentationInference", message: "Select an instance-label output path." }); return; }
  setRunning(true); setProgress(0, "Preparing building segmentation..."); viewer.clearLog();
  viewer.appendLog("Validating the model package and preparing instance vectorization...");
  try {
    const layer = await analysis.runAiInstanceVectorizationToMemoryAsync({
      modelPackagePath: modelPath, rasterPath, labelRasterPath: labelPath, provider,
      layerName: "building_predictions", instanceIdField: "instance_id", connectivity: 4,
    }, (percent, message) => setProgress(percent, message || "Running building segmentation..."));
    const result = layer.diagnostics; setProgress(95, "Opening source and prediction overlay...");
    predictionLayer?.close(); predictionLayer = layer; viewer.clearLayers(); viewer.addLayerFile(rasterPath); layer.addTo(viewer);
    viewer.setLayerStyle(0, { fillColor: "#FF3B30", fillOpacity: 125, lineColor: "#C5160A", lineWidth: 1.8 });
    viewer.refreshLayers(); viewer.fullExtent(); viewer.clearLog(); viewer.appendLog(diagnostics(result));
    setRunning(false); setProgress(100, "Inference complete"); viewer.setStatusText(`Building mask and ${Number(result.materializedCount || 0)} vector polygons created.`);
  } catch (error) { fail(error?.message || String(error)); }
}

function fail(message) {
  setRunning(false); setProgress(0, "Inference failed"); viewer?.clearLog(); viewer?.appendLog(`Inference failed:\n${message}`);
  dialog.showMessageBox({ type: "error", title: "BuildingSegmentationInference", message: String(message) });
}
async function browseModel() {
  const result = await dialog.showOpenDialog({ title: "Select GeoKernel model package", defaultPath: modelPath || undefined, properties: ["openDirectory"] });
  if (!result.canceled && result.filePaths[0]) { modelPath = result.filePaths[0]; viewer?.setControlValue(CONTROL.MODEL, modelPath); }
}
async function browseRaster() {
  const result = await dialog.showOpenDialog({ title: "Select input raster", defaultPath: rasterPath || undefined, properties: ["openFile"], filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
  if (!result.canceled && result.filePaths[0]) { rasterPath = result.filePaths[0]; labelPath = labelsFor(rasterPath); viewer?.setControlValue(CONTROL.RASTER, rasterPath); viewer?.setControlValue(CONTROL.LABELS, labelPath); openBaseRaster(); }
}
async function browseLabels() {
  const result = await dialog.showSaveDialog({ title: "Save instance labels", defaultPath: labelPath || undefined, filters: [{ name: "GeoTIFF", extensions: ["tif"] }] });
  if (!result.canceled && result.filePath) { labelPath = result.filePath; viewer?.setControlValue(CONTROL.LABELS, labelPath); }
}
function controlChanged(id, _numericValue, textValue) {
  if (id === CONTROL.MODEL) modelPath = textValue || ""; else if (id === CONTROL.RASTER) rasterPath = textValue || "";
  else if (id === CONTROL.LABELS) labelPath = textValue || ""; else if (id === CONTROL.PROVIDER) provider = textValue || "Auto";
  else if (id === CONTROL.MODEL_BROWSE) setImmediate(browseModel); else if (id === CONTROL.RASTER_BROWSE) setImmediate(browseRaster);
  else if (id === CONTROL.LABELS_BROWSE) setImmediate(browseLabels); else if (id === CONTROL.RUN) setImmediate(run);
}
function openBaseRaster() {
  predictionLayer?.close(); predictionLayer = null; viewer.clearLayers(); viewer.addLayerFile(rasterPath);
  viewer.setLayerName(0, "Buildings RGB source"); viewer.refreshLayers(); viewer.fullExtent();
}
async function prepareSamples() {
  try {
    setRunning(true); setProgress(5, "Preparing buildings sample data...");
    rasterPath = await ensureSampleFile(RASTER_URL, "buildings.zip", "buildings", "buildings.tif");
    const manifest = await ensureSampleFile(MODEL_URL, "buildings-model.zip", "buildings-model", "geokernel-model.json");
    modelPath = path.dirname(manifest); labelPath = labelsFor(rasterPath);
    viewer.setControlValue(CONTROL.MODEL, modelPath); viewer.setControlValue(CONTROL.RASTER, rasterPath); viewer.setControlValue(CONTROL.LABELS, labelPath);
    openBaseRaster(); viewer.clearLog(); viewer.appendLog("The buildings raster and ONNX model package are ready. Run inference to add building polygons.");
    setRunning(false); setProgress(0, "Ready");
  } catch (error) { fail(error?.message || String(error)); }
}
function startPump() {
  eventPump = setInterval(() => { if (!viewer) return; viewer.processEvents(); if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; }
    else if (visibleOnce) { if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 750) app.quit(); } }, 16);
}
async function start() {
  closing = false; keeper = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "BuildingSegmentationInference", width: 1280, height: 850, navigationToolbar: true });
  analysis = new AnalysisExecutor();
  viewer.addControlPanel({ title: "Building segmentation inference", area: "right", width: 420, controls: [
    { id: CONTROL.MODEL, type: "text", label: "Model package", value: modelPath }, { id: CONTROL.MODEL_BROWSE, type: "button", text: "Browse model package..." },
    { id: CONTROL.RASTER, type: "text", label: "Input raster", value: rasterPath }, { id: CONTROL.RASTER_BROWSE, type: "button", text: "Browse input raster..." },
    { id: CONTROL.LABELS, type: "text", label: "Instance labels", value: labelPath }, { id: CONTROL.LABELS_BROWSE, type: "button", text: "Browse instance labels..." },
    { id: CONTROL.PROVIDER, type: "combo", label: "Execution provider", options: ["Auto", "CPU", "CUDA", "DirectML"], value: "Auto" },
    { id: CONTROL.RUN, type: "button", text: "Run building segmentation inference" },
    { id: CONTROL.PROGRESS, type: "progress", label: "Progress", value: 0, textVisible: true, format: "%p%" },
    { id: CONTROL.STAGE, type: "text", label: "Stage", value: "Ready.", readOnly: true },
  ] }, controlChanged);
  viewer.addLogPanel("Inference diagnostics"); viewer.appendLog("Select a model package and an input raster."); viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback((event) => { if (event.eventType === ViewerEventType.DRAWING_PROGRESS_CHANGED && !busy) setProgress(event.intValue, event.text || "Rendering map...");
    else if (event.eventType === ViewerEventType.BUSY_CHANGED && !busy) setProgress(event.intValue ? 0 : 100, event.intValue ? "Rendering map..." : "Map ready"); });
  viewer.show(); viewer.processEvents(); startPump(); setImmediate(prepareSamples);
}
function stop() {
  closing = true; if (eventPump) clearInterval(eventPump); eventPump = null; predictionLayer?.close(); predictionLayer = null;
  if (viewer) try { viewer.close(); } catch {} viewer = null; analysis = null; keeper?.destroy(); keeper = null;
}
module.exports = { start, stop };
