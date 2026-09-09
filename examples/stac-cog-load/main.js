"use strict";

const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { ViewerEventType, ViewerTool, ViewerWindow } = require("geokernel-electron");

const CATALOG = "https://earth-search.aws.element84.com/v1";
const COLLECTION = "sentinel-2-l2a";
const CONTROL = { SEARCH: 1, CATALOG: 2, COLLECTION: 3, BBOX: 4, ITEMS: 5, PROGRESS: 6 };
const RASTER_OPTIONS = {
  prepareRasterOverviews: false,
  rasterTileCacheEnabled: false,
  rasterTileCachePixelBudget: 0,
  rasterTileCacheMaximumItemPixels: 0,
};

let viewer = null;
let keeper = null;
let worker = null;
let eventPump = null;
let visibleOnce = false;
let hiddenSince = 0;
let busy = false;
let sequence = 0;
let bboxText = "18.00, 59.25, 18.20, 59.40";

function parseBbox(text) {
  const values = String(text).split(",").map((part) => Number(part.trim()));
  return values.length === 4 && values.every(Number.isFinite)
    && values[0] < values[2] && values[1] < values[3]
    && values[0] >= -180 && values[2] <= 180 && values[1] >= -90 && values[3] <= 90
    ? values : null;
}

function viewerExtent(box, targetEpsg) {
  if (!targetEpsg) throw new Error("The COG coordinate system could not be determined.");
  const corners = [
    viewer.transformPoint(4326, targetEpsg, box[0], box[1]),
    viewer.transformPoint(4326, targetEpsg, box[0], box[3]),
    viewer.transformPoint(4326, targetEpsg, box[2], box[1]),
    viewer.transformPoint(4326, targetEpsg, box[2], box[3]),
  ];
  if (corners.some((point) => !point)) throw new Error("The WGS84 BBOX could not be transformed to the Viewer CRS.");
  const xs = corners.map((point) => point.x); const ys = corners.map((point) => point.y);
  const xMin = Math.min(...xs); const xMax = Math.max(...xs); const yMin = Math.min(...ys); const yMax = Math.max(...ys);
  const paddingX = (xMax - xMin) * 0.04; const paddingY = (yMax - yMin) * 0.04;
  return { xMin: xMin - paddingX, yMin: yMin - paddingY, xMax: xMax + paddingX, yMax: yMax + paddingY };
}

function progress(value, text) {
  if (!viewer) return;
  const bounded = Math.max(0, Math.min(100, value));
  viewer.setStatusText(`${bounded}% — ${text}`);
  viewer.setControlValue(CONTROL.PROGRESS, bounded);
  viewer.clearLog();
  viewer.appendLog(text);
}

function details(assets) {
  const lines = ["STAC + COG streaming mosaic", "", "Catalog: Earth Search v1", `Collection: ${COLLECTION}`, `Unique MGRS tiles: ${assets.length}`, ""];
  for (const asset of assets) {
    lines.push(`${asset.tile} | ${asset.itemId}`);
    lines.push(`Date/time: ${asset.datetime} | Cloud cover: ${asset.cloudCover}`);
    lines.push(`Content: ${asset.contentLength} bytes | Range: ${asset.acceptsRanges ? "yes" : "no"} | IFD: ${asset.firstIfdOffset}`);
    lines.push("");
  }
  lines.push("Only metadata and visible ranges are transferred; complete COG files are not downloaded.");
  return lines.join("\n");
}

function fail(message) {
  busy = false;
  if (!viewer) return;
  viewer.setControlEnabled(CONTROL.SEARCH, true);
  viewer.clearLog(); viewer.appendLog(`Load failed:\n${message}`);
  viewer.setStatusText("STAC COG load failed.");
}

function loadAssets(message, box) {
  if (!viewer || message.id !== sequence) return;
  try {
    viewer.clearLayers();
    let viewerEpsg = 0;
    for (let index = 0; index < message.assets.length; index += 1) {
      const value = 70 + Math.floor((index + 1) * 25 / message.assets.length);
      progress(value, `Opening COG tile ${index + 1} of ${message.assets.length}...`);
      viewer.addLayerFile(message.assets[index].path, RASTER_OPTIONS);
      if (index === 0) viewerEpsg = Number(viewer.layerInfo(0)?.coordinateSystem?.epsgCode ?? 0);
      viewer.processEvents();
    }
    viewer.refreshLayers();
    viewer.setControlOptions(CONTROL.ITEMS, message.assets.map((asset) => `${asset.tile} | ${asset.datetime} | cloud ${asset.cloudCover}`));
    viewer.setViewExtent(viewerExtent(box, viewerEpsg));
    viewer.clearLog(); viewer.appendLog(details(message.assets));
    viewer.setStatusText(`100% — ${message.assets.length} visual COG tiles are streaming through HTTP byte ranges.`);
    busy = false; viewer.setControlEnabled(CONTROL.SEARCH, true);
  } catch (error) { fail(error?.message ?? String(error)); }
}

function runSearch() {
  if (!viewer || busy) return;
  const box = parseBbox(bboxText);
  if (!box) { fail("Enter a valid WGS84 BBOX as: xmin, ymin, xmax, ymax"); return; }
  busy = true; viewer.setControlEnabled(CONTROL.SEARCH, false); viewer.setControlOptions(CONTROL.ITEMS, []);
  progress(2, "Starting STAC search...");
  worker.send({ type: "search", id: ++sequence, catalog: CATALOG, collection: COLLECTION, bbox: box });
  const requestId = sequence;
  const handler = (message) => {
    if (message.id !== requestId) return;
    if (message.type === "progress") progress(message.value, message.text);
    else if (message.type === "error") { worker.off("message", handler); fail(message.message); }
    else if (message.type === "result") { worker.off("message", handler); loadAssets(message, box); }
  };
  worker.on("message", handler);
}

function controlChanged(id, _numericValue, textValue) {
  if (id === CONTROL.BBOX) bboxText = textValue || bboxText;
  else if (id === CONTROL.SEARCH) setImmediate(runSearch);
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
  process.env.GDAL_DISABLE_READDIR_ON_OPEN = "EMPTY_DIR";
  process.env.CPL_VSIL_CURL_ALLOWED_EXTENSIONS = ".tif,.tiff";
  process.env.GDAL_CACHEMAX = "256";
  process.env.VSI_CACHE = "TRUE";
  process.env.VSI_CACHE_SIZE = "67108864";
  keeper = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "StacCogLoad", width: 1280, height: 820, navigationToolbar: true });
  viewer.addControlPanel({ title: "STAC COG streaming", area: "right", width: 390, controls: [
    { id: CONTROL.SEARCH, type: "button", text: "Search STAC and stream visual COG" },
    { id: CONTROL.CATALOG, type: "combo", label: "Catalog", options: [CATALOG], value: CATALOG },
    { id: CONTROL.COLLECTION, type: "combo", label: "Collection", options: ["Sentinel-2 L2A"], value: "Sentinel-2 L2A" },
    { id: CONTROL.BBOX, type: "text", label: "BBOX", value: bboxText, placeholder: "xmin, ymin, xmax, ymax" },
    { id: CONTROL.PROGRESS, type: "progress", label: "Progress", value: 0, textVisible: true, format: "%p%" },
    { id: CONTROL.ITEMS, type: "combo", label: "Selected STAC item", options: [] },
  ] }, controlChanged);
  viewer.addLogPanel("Cloud diagnostics");
  viewer.appendLog("Ready. Search the STAC catalog to select COG assets.");
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback((event) => {
    if (event.eventType === ViewerEventType.DRAWING_PROGRESS_CHANGED) {
      const value = Math.max(0, Math.min(100, event.intValue));
      viewer.setControlValue(CONTROL.PROGRESS, value);
      viewer.setStatusText(value >= 100 ? "100% — Map ready." : `${value}% — Rendering map...`);
    } else if (!busy && event.eventType === ViewerEventType.BUSY_CHANGED) {
      if (event.intValue) {
        viewer.setControlValue(CONTROL.PROGRESS, 0);
        viewer.setStatusText("Rendering map...");
      } else {
        viewer.setControlValue(CONTROL.PROGRESS, 100);
        viewer.setStatusText("100% — Map ready.");
      }
    }
  });
  viewer.show(); viewer.processEvents(); startPump();
  worker = fork(path.join(__dirname, "cloud-worker.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  worker.stdout.on("data", (data) => process.stdout.write(data)); worker.stderr.on("data", (data) => process.stderr.write(data));
  worker.on("error", (error) => fail(error.message));
  setImmediate(runSearch);
}

function stop() {
  if (eventPump) clearInterval(eventPump); eventPump = null;
  worker?.kill(); worker = null;
  if (viewer) try { viewer.close(); } catch {} viewer = null;
  keeper?.destroy(); keeper = null;
}

module.exports = { start, stop };
