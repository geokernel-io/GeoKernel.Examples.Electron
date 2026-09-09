"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const DEFAULT_WKT = "LINESTRING(-122.4194 37.7749, -121.8863 37.3382, -121.4944 38.5816, -120.7401 37.6391)";
const LINE_LAYER_NAME = "WKT LineString";

const CONTROL = Object.freeze({ WKT: 1, READ: 2, RESET: 3 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let inputWkt = DEFAULT_WKT;
let controlsReady = false;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function toWebMercator(point) {
  const originShift = 20037508.342789244;
  const longitude = Math.max(-180, Math.min(180, Number(point.x)));
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, Number(point.y)));
  return {
    x: longitude * originShift / 180,
    y: Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * originShift / Math.PI,
  };
}

function paddedExtent(points, paddingRatio = 0.25, minimumPadding = 250000) {
  const xValues = points.map((point) => Number(point.x));
  const yValues = points.map((point) => Number(point.y));
  const xMin = Math.min(...xValues);
  const yMin = Math.min(...yValues);
  const xMax = Math.max(...xValues);
  const yMax = Math.max(...yValues);
  const paddingX = Math.max(minimumPadding, (xMax - xMin) * paddingRatio);
  const paddingY = Math.max(minimumPadding, (yMax - yMin) * paddingRatio);
  return extent(xMin - paddingX, yMin - paddingY, xMax + paddingX, yMax + paddingY);
}

function extentText(value, decimals) {
  return `(${value.xMin.toFixed(decimals)}, ${value.yMin.toFixed(decimals)}) - (${value.xMax.toFixed(decimals)}, ${value.yMax.toFixed(decimals)})`;
}

function detailsText(wkt, lonLatPoints, webMercatorExtent) {
  const lonLatExtent = paddedExtent(lonLatPoints, 0, 0);
  return [
    "WktReadPolyline sample",
    "",
    "API",
    "GisWktReader::readLineString(wkt)",
    "",
    "Input WKT",
    wkt,
    "",
    "Parsed line",
    "Parts: 1",
    `Vertices: ${lonLatPoints.length}`,
    `Lon/lat extent: ${extentText(lonLatExtent, 6)}`,
    "",
    "Displayed over OSM",
    "Input CRS: EPSG:4326",
    "Polyline layer / Viewer / OSM CRS: EPSG:3857",
    `WebMercator view extent: ${extentText(webMercatorExtent, 3)}`,
    "",
    "Round-trip WKT",
    viewer.writeWktLineString(lonLatPoints),
  ].join("\n");
}

function showLineString() {
  const wkt = inputWkt.trim();
  const parsed = viewer.readWktLineString(wkt);
  const lonLatPoints = parsed.map((item) => ({ x: Number(item.x), y: Number(item.y) }));
  if (lonLatPoints.length < 2 || lonLatPoints.some((item) => !Number.isFinite(item.x) || !Number.isFinite(item.y))) {
    throw new Error("A LineString must contain at least two valid vertices.");
  }
  const projectedPoints = lonLatPoints.map(toWebMercator);
  const viewExtent = paddedExtent(projectedPoints);

  viewer.removeLayerByName(LINE_LAYER_NAME);
  viewer.addPolylineLayer(LINE_LAYER_NAME, [projectedPoints], {
    lineColor: "#E4572E",
    lineWidth: 4,
    pointColor: "#F3A712",
    pointSize: 7,
  });
  if (!viewer.layerInfoByName(LINE_LAYER_NAME)?.name) throw new Error("WKT LineString layer could not be created.");
  viewer.setViewExtent(viewExtent);
  viewer.clearLog();
  viewer.appendLog(detailsText(wkt, lonLatPoints, viewExtent));
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.setStatusText(`GisWktReader::readLineString parsed ${lonLatPoints.length} vertices.`);
}

function readSafely() {
  try {
    showLineString();
  } catch (error) {
    viewer.removeLayerByName(LINE_LAYER_NAME);
    viewer.clearLog();
    viewer.appendLog(`WKT parse failed:\n${error.message}`);
    viewer.refreshLayers();
    viewer.setStatusText("WKT parse failed.");
  }
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.WKT) inputWkt = textValue;
  else if (controlId === CONTROL.READ) readSafely();
  else if (controlId === CONTROL.RESET) {
    inputWkt = DEFAULT_WKT;
    viewer.setControlValue(CONTROL.WKT, inputWkt);
    readSafely();
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
  viewer = new ViewerWindow({ title: "WktReadPolyline", width: 1100, height: 720, navigationToolbar: true });
  viewer.addControlPanel({
    title: "WKT LineString input",
    width: 460,
    controls: [
      { id: CONTROL.WKT, type: "text", label: "WKT", value: DEFAULT_WKT },
      { id: CONTROL.READ, type: "button", text: "Read LineString" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("WKT LineString details");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  viewer.setStatusText("Loading OpenStreetMap...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  controlsReady = true;
  readSafely();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  controlsReady = false;
  if (viewer) {
    try { viewer.close(); } catch { /* Native window may already be destroyed. */ }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
