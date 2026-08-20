"use strict";

const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow } = require("geokernel-electron");

const REMOTE_URL = "https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles";
const CONTROL = { LOAD: 1, URL: 2, PROGRESS: 3 };
let viewer = null; let keeper = null; let worker = null; let eventPump = null;
let visibleOnce = false; let hiddenSince = 0; let busy = false; let sequence = 0; let remoteUrl = REMOTE_URL;
let probeTimer = null;

function basemapStyle(sourceName) {
  const styles = {
    earth: { fillColor: "#f1eee8", fillOpacity: 255, lineWidth: 0 },
    landcover: { fillColor: "#dce8d5", fillOpacity: 255, lineWidth: 0 },
    landuse: { fillColor: "#e7e1d5", fillOpacity: 255, lineWidth: 0 },
    water: { fillColor: "#b9d9eb", fillOpacity: 255, lineColor: "#9bc6df", lineWidth: 0.35 },
    buildings: { fillColor: "#d4ccc2", fillOpacity: 255, lineColor: "#b8aea3", lineWidth: 0.25 },
    roads: { lineColor: "#ffffff", lineWidth: 1.15, fillOpacity: 0 },
    transit: { lineColor: "#d28a54", lineWidth: 1, fillOpacity: 0 },
    boundaries: { lineColor: "#9a8f84", lineWidth: 0.55, fillOpacity: 0 },
    physical_line: { lineColor: "#91a69a", lineWidth: 0.5, fillOpacity: 0 },
    natural: { fillColor: "#cfe3c4", fillOpacity: 255, lineColor: "#9fbea0", lineWidth: 0.25 },
  };
  return styles[String(sourceName).toLowerCase()] ?? { pointColor: "#557f9b", pointSize: 2.5, lineWidth: 0.3 };
}

function progress(value, text) {
  if (!viewer) return;
  const bounded = Math.max(0, Math.min(100, value));
  viewer.setControlValue(CONTROL.PROGRESS, bounded); viewer.setStatusText(`${bounded}% — ${text}`);
}

function report(probe) {
  return [
    "Cloud PMTiles streaming", "", `URL: ${probe.url ?? remoteUrl}`,
    `Content length: ${probe.contentLength ?? 0} bytes`, `Content type: ${probe.contentType ?? ""}`,
    `Accept-Ranges: ${probe.acceptsRanges ? "yes" : "no"}`,
    `PMTiles header: ${probe.headerValid ? "valid" : "invalid"}`,
    `Specification: v${probe.specificationVersion ?? 0}`,
    `Zoom range: ${probe.minimumZoom ?? 0}-${probe.maximumZoom ?? 0}`,
    `Root directory: ${probe.rootDirectoryLength ?? 0} bytes`, "GDAL source: /vsicurl/", "",
    probe.diagnostic ?? "", "", "Only metadata and requested byte ranges are transferred; the complete PMTiles archive is not downloaded.",
  ].join("\n");
}

function fail(message) {
  if (probeTimer) clearTimeout(probeTimer); probeTimer = null;
  busy = false; if (!viewer) return; viewer.setControlEnabled(CONTROL.LOAD, true);
  viewer.clearLog(); viewer.appendLog(`Load failed:\n${message}`); viewer.setStatusText("Cloud PMTiles load failed.");
}

function openLayers(message) {
  if (!viewer || message.id !== sequence) return;
  if (probeTimer) clearTimeout(probeTimer); probeTimer = null;
  try {
    progress(35, "Discovering PMTiles source layers...");
    const layers = viewer.pmTilesSourceLayers(message.path);
    if (!Array.isArray(layers) || layers.length === 0) throw new Error("PMTiles contains no drawable source layers.");
    viewer.clearLayers(); viewer.clearLog(); viewer.appendLog(report(message.probe));
    let index = 0;
    const openNext = () => {
      if (!viewer || message.id !== sequence) return;
      if (index >= layers.length) {
        viewer.refreshLayers(); viewer.fullExtent(); progress(100, `${layers.length} PMTiles source layers are streaming through HTTP byte ranges.`);
        busy = false; viewer.setControlEnabled(CONTROL.LOAD, true); return;
      }
      const source = layers[index]; const name = source.name || `Layer ${index + 1}`;
      progress(35 + Math.floor((index + 1) * 55 / layers.length), `Opening ${name}...`);
      viewer.processEvents();
      viewer.addLayerFile(message.path, { sourceLayerIndex: Number(source.index ?? index), useSpatialIndex: false });
      viewer.setLayerName(0, name); viewer.setLayerStyle(0, basemapStyle(name)); index += 1;
      setImmediate(openNext);
    };
    setImmediate(openNext);
  } catch (error) { fail(error?.message ?? String(error)); }
}

function run() {
  if (!viewer || busy) return;
  if (!/^https?:\/\//i.test(remoteUrl)) { fail("Enter a valid HTTP or HTTPS URL."); return; }
  busy = true; viewer.setControlEnabled(CONTROL.LOAD, false); progress(10, "Probing the remote PMTiles v3 header...");
  const requestId = ++sequence;
  const handler = (message) => {
    if (message.id !== requestId) return;
    worker.off("message", handler);
    if (message.type === "error") fail(message.message); else openLayers(message);
  };
  worker.on("message", handler);
  probeTimer = setTimeout(() => {
    worker?.off("message", handler);
    if (requestId === sequence) fail("PMTiles probe timed out after 35 seconds.");
  }, 35000);
  worker.send({ type: "probe", id: requestId, url: remoteUrl });
}

function controlChanged(id, _numericValue, textValue) {
  if (id === CONTROL.URL) remoteUrl = textValue || remoteUrl;
  else if (id === CONTROL.LOAD) setImmediate(run);
}

function startPump() {
  eventPump = setInterval(() => {
    if (!viewer) return; viewer.processEvents();
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
  viewer = new ViewerWindow({ title: "CloudPmTilesLoad", width: 1280, height: 820, navigationToolbar: true });
  viewer.addControlPanel({ title: "Cloud PMTiles streaming", area: "right", width: 390, controls: [
    { id: CONTROL.LOAD, type: "button", text: "Probe and stream PMTiles" },
    { id: CONTROL.URL, type: "text", label: "Remote PMTiles URL", value: remoteUrl },
    { id: CONTROL.PROGRESS, type: "progress", label: "Progress", value: 0, textVisible: true, format: "%p%" },
  ] }, controlChanged);
  viewer.addLogPanel("Cloud diagnostics"); viewer.appendLog("Ready."); viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback((event) => {
    if (event.eventType === ViewerEventType.DRAWING_PROGRESS_CHANGED) {
      const value = Math.max(0, Math.min(100, event.intValue)); viewer.setControlValue(CONTROL.PROGRESS, value); viewer.setStatusText(value >= 100 ? "100% — Map ready." : `${value}% — Rendering map...`);
    } else if (!busy && event.eventType === ViewerEventType.BUSY_CHANGED) {
      viewer.setControlValue(CONTROL.PROGRESS, event.intValue ? 0 : 100); viewer.setStatusText(event.intValue ? "Rendering map..." : "100% — Map ready.");
    }
  });
  viewer.show(); viewer.processEvents(); startPump();
  worker = fork(path.join(__dirname, "cloud-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data));
  worker.on("error", (error) => fail(error.message));
  worker.on("exit", (code, signal) => {
    if (busy) fail(`PMTiles probe worker stopped unexpectedly (${signal || `exit ${code}`}).`);
  });
  setImmediate(run);
}

function stop() {
  if (probeTimer) clearTimeout(probeTimer); probeTimer = null;
  if (eventPump) clearInterval(eventPump); eventPump = null; worker?.kill(); worker = null;
  if (viewer) try { viewer.close(); } catch {} viewer = null; keeper?.destroy(); keeper = null;
}

module.exports = { start, stop };
