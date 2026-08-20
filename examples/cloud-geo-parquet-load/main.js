"use strict";

const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow } = require("geokernel-electron");

const REMOTE_URL = "https://raw.githubusercontent.com/opengeospatial/geoparquet/main/examples/example.parquet";
const CONTROL = { LOAD: 1, URL: 2, PROGRESS: 3 };
let viewer = null; let keeper = null; let worker = null; let eventPump = null; let probeTimer = null;
let visibleOnce = false; let hiddenSince = 0; let busy = false; let sequence = 0; let remoteUrl = REMOTE_URL;

function progress(value, text) {
  if (!viewer) return;
  const bounded = Math.max(0, Math.min(100, value));
  viewer.setControlValue(CONTROL.PROGRESS, bounded);
  viewer.setStatusText(`${bounded}% — ${text}`);
}

function report(probe) {
  return [
    "Cloud GeoParquet streaming", "", `URL: ${probe.url ?? remoteUrl}`,
    `Content length: ${probe.contentLength ?? 0} bytes`, `Content type: ${probe.contentType ?? ""}`,
    `Accept-Ranges: ${probe.acceptsRanges ? "yes" : "no"}`,
    `PAR1 header: ${probe.headerValid ? "valid" : "invalid"}`,
    `PAR1 footer: ${probe.footerValid ? "valid" : "invalid"}`, "GDAL source: /vsicurl/", "",
    probe.diagnostic ?? "", "",
    "Only metadata and requested byte ranges are transferred; the complete GeoParquet file is not downloaded.",
  ].join("\n");
}

function clearProbeTimer() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
}

function fail(message) {
  clearProbeTimer(); busy = false;
  if (!viewer) return;
  viewer.setControlEnabled(CONTROL.LOAD, true);
  viewer.setControlValue(CONTROL.PROGRESS, 0);
  viewer.clearLog(); viewer.appendLog(`Load failed:\n${message}`);
  viewer.setStatusText("Cloud GeoParquet load failed.");
}

function openLayer(message) {
  if (!viewer || message.id !== sequence) return;
  clearProbeTimer();
  try {
    progress(60, "Opening GeoParquet layer...");
    viewer.clearLayers();
    viewer.addLayerFile(message.path);
    viewer.setLayerName(0, "Remote GeoParquet");
    viewer.clearLog(); viewer.appendLog(report(message.probe));
    viewer.fullExtent();
    progress(100, "GeoParquet is streaming through HTTP byte ranges.");
    busy = false; viewer.setControlEnabled(CONTROL.LOAD, true);
  } catch (error) { fail(error?.message ?? String(error)); }
}

function run() {
  if (!viewer || busy) return;
  if (!/^https?:\/\//i.test(remoteUrl)) { fail("Enter a valid HTTP or HTTPS URL."); return; }
  busy = true; viewer.setControlEnabled(CONTROL.LOAD, false);
  viewer.clearLog(); viewer.appendLog("Reading the GeoParquet header and footer with HTTP ranges...");
  progress(10, "Probing remote object...");
  const requestId = ++sequence;
  const handler = (message) => {
    if (message.id !== requestId) return;
    worker.off("message", handler);
    if (message.type === "error") fail(message.message); else openLayer(message);
  };
  worker.on("message", handler);
  probeTimer = setTimeout(() => {
    worker?.off("message", handler);
    if (requestId === sequence) fail("GeoParquet probe timed out after 35 seconds.");
  }, 35000);
  worker.send({ type: "probe", id: requestId, url: remoteUrl });
}

function controlChanged(id, _numericValue, textValue) {
  if (id === CONTROL.URL) remoteUrl = textValue || remoteUrl;
  else if (id === CONTROL.LOAD) setImmediate(run);
}

function startPump() {
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { visibleOnce = true; hiddenSince = 0; }
    else if (visibleOnce) { if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 750) app.quit(); }
  }, 16);
}

async function start() {
  Object.assign(process.env, {
    GDAL_DISABLE_READDIR_ON_OPEN: "EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS: ".parquet,.pmtiles",
    GDAL_CACHEMAX: "256", VSI_CACHE: "TRUE", VSI_CACHE_SIZE: "67108864",
    CPL_VSIL_CURL_CHUNK_SIZE: "1048576", CPL_VSIL_CURL_CACHE_SIZE: "67108864",
    GDAL_HTTP_MULTIRANGE: "YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES: "YES",
    GDAL_HTTP_CONNECTTIMEOUT: "10", GDAL_HTTP_TIMEOUT: "30",
  });
  keeper = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "CloudGeoParquetLoad", width: 1280, height: 820, navigationToolbar: true });
  viewer.addControlPanel({ title: "Cloud GeoParquet streaming", area: "right", width: 390, controls: [
    { id: CONTROL.LOAD, type: "button", text: "Probe and stream GeoParquet" },
    { id: CONTROL.URL, type: "text", label: "Remote GeoParquet URL", value: remoteUrl },
    { id: CONTROL.PROGRESS, type: "progress", label: "Progress", value: 0, textVisible: true, format: "%p%" },
  ] }, controlChanged);
  viewer.addLogPanel("Cloud diagnostics"); viewer.appendLog("Ready."); viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback((event) => {
    if (event.eventType === ViewerEventType.DRAWING_PROGRESS_CHANGED) {
      const value = Math.max(0, Math.min(100, event.intValue));
      viewer.setControlValue(CONTROL.PROGRESS, value);
      viewer.setStatusText(value >= 100 ? "100% — Map ready." : `${value}% — ${event.textValue || "Rendering map..."}`);
    } else if (!busy && event.eventType === ViewerEventType.BUSY_CHANGED) {
      viewer.setControlValue(CONTROL.PROGRESS, event.intValue ? 0 : 100);
      viewer.setStatusText(event.intValue ? "Rendering map..." : "100% — Map ready.");
    }
  });
  viewer.show(); viewer.processEvents(); startPump();
  worker = fork(path.join(__dirname, "cloud-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data));
  worker.on("error", (error) => fail(error.message));
  worker.on("exit", (code, signal) => { if (busy) fail(`GeoParquet probe worker stopped unexpectedly (${signal || `exit ${code}`}).`); });
  setImmediate(run);
}

function stop() {
  clearProbeTimer();
  if (eventPump) clearInterval(eventPump); eventPump = null;
  worker?.kill(); worker = null;
  if (viewer) try { viewer.close(); } catch {} viewer = null;
  keeper?.destroy(); keeper = null;
}

module.exports = { start, stop };
