"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  AnalysisBackend, AnalysisDataKind, AnalysisExecutor, AnalysisOperation,
  ViewerTool, ViewerWindow,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const DATA_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/stockholm_data.zip";
const CONTROL = { RUN: 1, CANCEL: 2, CLASS: 3, LIMIT: 4, BBOX: 5, PROGRESS: 6, STAGE: 7 };
let viewer = null; let keeper = null; let eventPump = null; let poll = null;
let visibleOnce = false; let hiddenSince = 0; let closing = false;
let parquetPath = ""; let buildingClass = "apartments"; let maximumResults = 25000;
let analysis = null; let job = null; let layer = null;

function request() {
  return {
    operation: AnalysisOperation.SpatialFilter,
    backend: AnalysisBackend.Auto,
    inputKind: AnalysisDataKind.GeoParquet,
    source: parquetPath,
    hasAttributeFilter: true,
    hasSpatialFilter: true,
    projectionRequired: true,
    options: {
      columns: ["id", "class", "geometry"],
      predicateSql: "class = ?",
      predicateParameters: [buildingClass],
      extent: [18.04, 59.30, 18.10, 59.35],
      limit: maximumResults,
    },
  };
}

function attemptsText(value) {
  const plan = value.plan;
  const lines = [
    "ANALYSIS PLAN", "Requested backend: Auto", `Selected backend: ${value.backend}`,
    `Predicate pushdown: ${plan.usesPredicatePushdown ? "yes" : "no"}`,
    `Projection pushdown: ${plan.usesProjectionPushdown ? "yes" : "no"}`,
    "", plan.explanation, "", "EXECUTION ATTEMPTS",
  ];
  for (const attempt of value.attempts) {
    const suffix = attempt.message ? ` — ${attempt.message}` : "";
    lines.push(`${attempt.backend}: ${attempt.succeeded ? "success" : "failed"} (${attempt.elapsedMilliseconds} ms)${suffix}`);
  }
  return lines.join("\n");
}

function setProgress(value, text) {
  if (!viewer) return;
  const bounded = Math.max(0, Math.min(100, Math.round(value || 0)));
  viewer.setControlValue(CONTROL.PROGRESS, bounded);
  viewer.setControlValue(CONTROL.STAGE, text);
  viewer.setStatusText(text);
}

function setRunning(value) {
  viewer?.setControlEnabled(CONTROL.RUN, !value && Boolean(parquetPath));
  viewer?.setControlEnabled(CONTROL.CANCEL, value);
}

function disposeOutput() {
  if (layer) { try { layer.close(); } catch {} layer = null; }
  if (job) { try { job.close(); } catch {} job = null; }
}

function beginAnalysis() {
  if (!viewer || !parquetPath || job && !job.isFinished) return;
  disposeOutput();
  viewer.clearLog(); setRunning(true); setProgress(0, "Queuing analysis...");
  try {
    job = analysis.executeAsync(request());
    poll = setInterval(pollJob, 40);
  } catch (error) { finishError(error); }
}

function cancelAnalysis() {
  if (job && !job.isFinished) {
    try { job.cancel(); } catch (error) { finishError(error); }
  }
}

function pollJob() {
  if (closing || !viewer || !job) return;
  try {
    const state = job.progress;
    setProgress(state.percent, `${state.stage || "Running"} — ${state.message || ""}`);
    if (!job.isFinished) return;
    clearInterval(poll); poll = null;
    const result = job.wait();
    try {
      const value = result.value;
      viewer.clearLog(); viewer.appendLog(attemptsText(value));
      if (value.cancelled) { setRunning(false); setProgress(0, "Analysis cancelled."); return; }
      if (!value.succeeded) { setRunning(false); setProgress(0, value.message || "Analysis failed."); return; }
      layer = result.materialize({ name: `Filtered ${buildingClass} buildings`, skipInvalidGeometries: true });
      viewer.clearLayers(); layer.addTo(viewer);
      viewer.setLayerStyle(viewer.layerCount() - 1, { fillColor: "#55B7E9", lineColor: "#116A9B", lineWidth: 0.8 });
      viewer.fullExtent();
      const materialized = layer.diagnostics;
      viewer.appendLog(`\nMATERIALIZATION\nSource rows: ${materialized.sourceRowCount || 0}\nLayer features: ${materialized.materializedCount || 0}\nSkipped: ${materialized.skippedCount || 0}`);
      setRunning(false); setProgress(100, `${materialized.materializedCount || 0} selected and displayed with ${value.backend}.`);
    } finally { result.close(); }
  } catch (error) { finishError(error); }
}

function finishError(error) {
  if (poll) { clearInterval(poll); poll = null; }
  setRunning(false); setProgress(0, "Analysis failed.");
  viewer?.clearLog(); viewer?.appendLog(`Analysis failed:\n${error?.message || error}`);
}

function controlChanged(id, numericValue, textValue) {
  if (id === CONTROL.CLASS) buildingClass = textValue || "apartments";
  else if (id === CONTROL.LIMIT) maximumResults = Math.max(1, Math.min(100000, Math.round(numericValue || 25000)));
  else if (id === CONTROL.RUN) setImmediate(beginAnalysis);
  else if (id === CONTROL.CANCEL) setImmediate(cancelAnalysis);
}

function startEventPump() {
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; }
    else if (visibleOnce) {
      if (!hiddenSince) hiddenSince = Date.now();
      if (Date.now() - hiddenSince > 750) app.quit();
    }
  }, 16);
}

async function start() {
  closing = false;
  keeper = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "AnalysisGeoParquetFilter", width: 1220, height: 790 });
  viewer.addControlPanel({ title: "Backend-neutral analysis", area: "right", width: 340, controls: [
    { id: CONTROL.CLASS, type: "combo", label: "Building class", options: ["apartments", "house", "commercial", "industrial"], value: "apartments" },
    { id: CONTROL.LIMIT, type: "number", label: "Maximum results", value: 25000, minimum: 1, maximum: 100000, step: 1, decimals: 0 },
    { id: CONTROL.BBOX, type: "text", label: "BBOX", value: "18.04, 59.30, 18.10, 59.35", readOnly: true },
    { id: CONTROL.RUN, type: "button", text: "Run automatic analysis", enabled: false },
    { id: CONTROL.CANCEL, type: "button", text: "Cancel", enabled: false },
    { id: CONTROL.PROGRESS, type: "progress", label: "Progress", value: 0, textVisible: true, format: "%p%" },
    { id: CONTROL.STAGE, type: "text", label: "Stage", value: "Ready.", readOnly: true },
  ] }, controlChanged);
  viewer.addLogPanel("Analysis diagnostics");
  viewer.setTool(ViewerTool.PAN); viewer.setStatusText("Preparing Stockholm GeoParquet data...");
  viewer.show(); viewer.processEvents(); startEventPump();
  analysis = new AnalysisExecutor();
  parquetPath = await ensureSampleFile(DATA_URL, "stockholm_data.zip", ".", path.join("stockholm_data", "stockholm_buildings.parquet"));
  if (!viewer || !parquetPath) return;
  viewer.setControlEnabled(CONTROL.RUN, true);
  setProgress(0, `Ready: ${path.basename(parquetPath)}`);
  setImmediate(beginAnalysis);
}

function stop() {
  closing = true;
  if (poll) clearInterval(poll);
  if (eventPump) clearInterval(eventPump);
  if (job && !job.isFinished) try { job.cancel(); } catch {}
  disposeOutput();
  if (viewer) try { viewer.close(); } catch {}
  viewer = null; keeper?.destroy(); keeper = null;
}

module.exports = { start, stop };
