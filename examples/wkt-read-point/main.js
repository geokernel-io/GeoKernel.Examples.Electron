"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const DEFAULT_WKT = "POINT(-122.4194 37.7749)";
const POINT_LAYER_NAME = "WKT Point";

const CONTROL = Object.freeze({
  WKT: 1,
  READ: 2,
  RESET: 3,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let inputWkt = DEFAULT_WKT;
let controlsReady = false;
let viewInitialized = false;

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

function detailsText(wkt, lonLat, webMercator) {
  return [
    "WktReadPoint sample",
    "",
    "API",
    "GisWktReader::readPoint(wkt)",
    "",
    "Input WKT",
    wkt,
    "",
    "Parsed point",
    `Longitude: ${Number(lonLat.x).toFixed(6)}`,
    `Latitude: ${Number(lonLat.y).toFixed(6)}`,
    "Input / point layer CRS: EPSG:4326",
    "",
    "Projected display point",
    `X: ${Number(webMercator.x).toFixed(3)}`,
    `Y: ${Number(webMercator.y).toFixed(3)}`,
    "Viewer / OSM CRS: EPSG:3857",
    "",
    "Round-trip WKT",
    viewer.writeWktPoint(lonLat.x, lonLat.y),
  ].join("\n");
}

function toWebMercator(lonLat) {
  const originShift = 20037508.342789244;
  const longitude = Math.max(-180, Math.min(180, Number(lonLat.x)));
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, Number(lonLat.y)));
  return {
    x: longitude * originShift / 180,
    y: Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * originShift / Math.PI,
  };
}

function showPoint() {
  if (!viewer) return;
  const wkt = inputWkt.trim();
  const lonLat = viewer.readWktPoint(wkt);
  if (!lonLat) throw new Error("GisWktReader::readPoint returned no point.");
  const webMercator = toWebMercator(lonLat);

  viewer.removeLayerByName(POINT_LAYER_NAME);
  viewer.addAttributedPointLayer(
    POINT_LAYER_NAME,
    [[lonLat.x, lonLat.y]],
    [{ name: "POINT" }],
    {
      pointColor: "#E85D3A",
      pointOutlineColor: "#8F2D15",
      pointSize: 13,
      lineWidth: 2,
      showLabels: true,
      labelField: "name",
      labelColor: "#1F2D2D",
      labelFontSize: 11,
      labelOffsetX: 10,
      labelOffsetY: -8,
    },
    4326,
  );
  const pointLayerIndex = Number(viewer.layerInfoByName(POINT_LAYER_NAME)?.index ?? -1);
  if (pointLayerIndex < 0) throw new Error("WKT point layer could not be created.");

  if (!viewInitialized) {
    const horizontalSpan = 2500000;
    const verticalSpan = 1800000;
    viewer.setViewExtent(extent(
      webMercator.x - horizontalSpan,
      webMercator.y - verticalSpan,
      webMercator.x + horizontalSpan,
      webMercator.y + verticalSpan,
    ));
    viewInitialized = true;
  }
  viewer.clearLog();
  viewer.appendLog(detailsText(wkt, lonLat, webMercator));
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  viewer.setStatusText(`GisWktReader::readPoint parsed lon/lat POINT(${lonLat.x.toFixed(6)} ${lonLat.y.toFixed(6)}) over OSM.`);
}

function readPointSafely() {
  try {
    showPoint();
  } catch (error) {
    viewer.clearLog();
    viewer.appendLog(`WKT parse failed:\n${error.message}`);
    viewer.setStatusText("WKT parse failed.");
  }
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.WKT) {
    inputWkt = textValue;
  } else if (controlId === CONTROL.READ) {
    readPointSafely();
  } else if (controlId === CONTROL.RESET) {
    inputWkt = DEFAULT_WKT;
    viewInitialized = false;
    viewer.setControlValue(CONTROL.WKT, inputWkt);
    readPointSafely();
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
  viewer = new ViewerWindow({ title: "WktReadPoint", width: 1120, height: 800, navigationToolbar: true });
  viewer.addControlPanel({
    title: "WKT point input",
    width: 430,
    controls: [
      { id: CONTROL.WKT, type: "text", label: "WKT", value: DEFAULT_WKT },
      { id: CONTROL.READ, type: "button", text: "Read Point" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("WKT point details");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) {
    throw new Error("Viewer CRS could not be set to EPSG:3857.");
  }
  viewer.setStatusText("Loading OpenStreetMap...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  controlsReady = true;
  readPointSafely();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  controlsReady = false;
  viewInitialized = false;
  if (viewer) {
    try { viewer.close(); } catch { /* Native window may already be destroyed. */ }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
