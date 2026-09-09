"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const PRESETS = Object.freeze({
  Point: '{"type":"Point","coordinates":[-122.4194,37.7749]}',
  LineString: '{"type":"LineString","coordinates":[[-122.4194,37.7749],[-121.8863,37.3382],[-121.4944,38.5816],[-120.7401,37.6391]]}',
  Polygon: '{"type":"Polygon","coordinates":[[[-123.25,37.15],[-122.15,36.95],[-121.55,37.65],[-122.05,38.35],[-123.05,38.15],[-123.25,37.15]]]}',
  MultiPolygon: '{"type":"MultiPolygon","coordinates":[[[[-123.25,37.15],[-122.25,36.95],[-121.85,37.65],[-122.45,38.20],[-123.15,37.95],[-123.25,37.15]]],[[[-121.60,36.75],[-120.70,36.70],[-120.45,37.35],[-121.25,37.65],[-121.60,36.75]]]]}',
});
const CONTROL = Object.freeze({ PRESET: 1, JSON: 2, READ: 3, RESET: 4 });
const LAYER_NAMES = ["GeoJSON Point", "GeoJSON LineString", "GeoJSON Polygon"];
const STYLE = Object.freeze({
  Point: { pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 14.0, lineWidth: 1.5 },
  Polyline: { lineColor: "#E4572E", lineWidth: 4.0, pointColor: "#F3A712", pointSize: 7.0 },
  Polygon: { fillColor: "#88D18A", fillOpacity: 128, lineColor: "#1F7A4D", lineWidth: 2.5 },
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let preset = "Point";
let inputJson = PRESETS.Point;

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

function bounds(points, paddingRatio = 0, minimumPadding = 0) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMin = Math.min(...xs);
  const yMin = Math.min(...ys);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const paddingX = Math.max(minimumPadding, (xMax - xMin) * paddingRatio);
  const paddingY = Math.max(minimumPadding, (yMax - yMin) * paddingRatio);
  return extent(xMin - paddingX, yMin - paddingY, xMax + paddingX, yMax + paddingY);
}

function extentText(value, decimals) {
  return `(${value.xMin.toFixed(decimals)}, ${value.yMin.toFixed(decimals)}) - (${value.xMax.toFixed(decimals)}, ${value.yMax.toFixed(decimals)})`;
}

function clearGeometryLayers() {
  for (const name of LAYER_NAMES) viewer.removeLayerByName(name);
}

function addGeometry(shapeClass, projectedParts) {
  if (shapeClass === "Point") {
    return viewer.addPointLayer("GeoJSON Point", [projectedParts[0][0]], STYLE.Point);
  }
  if (shapeClass === "Polyline") {
    return viewer.addPolylineLayer("GeoJSON LineString", projectedParts, STYLE.Polyline);
  }
  return viewer.addPolygonLayer("GeoJSON Polygon", projectedParts, STYLE.Polygon);
}

function readGeoJson() {
  const input = inputJson.trim();
  if (!input) throw new Error("Input GeoJSON is empty.");
  const geometry = viewer.readGeoJsonGeometry(input);
  const shapeClass = String(geometry.shapeClass || "");
  const parts = (geometry.parts || []).map((part) =>
    part.map((point) => ({ x: Number(point.x), y: Number(point.y) })));
  if (!["Point", "Polyline", "Polygon"].includes(shapeClass) || !parts.length || parts.some((part) => !part.length)) {
    throw new Error("GisGeoJsonReader::read returned an empty or unsupported shape.");
  }
  clearGeometryLayers();
  const lonLatPoints = parts.flat();
  const projectedParts = parts.map((part) => part.map(toWebMercator));
  const viewExtent = bounds(projectedParts.flat(), 0.35, 250000);
  const layerIndex = addGeometry(shapeClass, projectedParts);
  if (layerIndex < 0) throw new Error(`GeoJSON ${shapeClass} layer could not be created.`);
  viewer.setViewExtent(viewExtent);
  viewer.clearLog();
  viewer.appendLog([
    "GeoJsonRead sample", "", "API", "GisGeoJsonReader::read(jsonString)", "", "Input GeoJSON geometry", input, "",
    "Parsed shape", `Shape class: ${shapeClass}`, `Parts: ${parts.length}`, `Vertices: ${lonLatPoints.length}`,
    `Lon/lat extent: ${extentText(bounds(lonLatPoints), 6)}`, "", "Displayed over OSM", "Input/layer CRS: EPSG:4326",
    "Viewer/OSM CRS: EPSG:3857", `WebMercator view extent: ${extentText(viewExtent, 3)}`,
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setStatusText(`GisGeoJsonReader::read parsed ${shapeClass} with ${lonLatPoints.length} vertices.`);
}

function readSafely() {
  try { readGeoJson(); }
  catch (error) {
    clearGeometryLayers();
    viewer.clearLog();
    viewer.appendLog(`GeoJSON parse failed:\n${error.message}`);
    viewer.refreshLayers();
    viewer.setStatusText("GeoJSON parse failed.");
  }
}

function resetInput() {
  inputJson = PRESETS[preset];
  viewer.setControlValue(CONTROL.JSON, inputJson);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.PRESET) {
    preset = textValue;
    resetInput();
    readSafely();
  } else if (controlId === CONTROL.JSON) inputJson = textValue;
  else if (controlId === CONTROL.READ) readSafely();
  else if (controlId === CONTROL.RESET) { resetInput(); readSafely(); }
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { viewerWasVisible = true; viewerHiddenSince = 0; }
    else if (viewerWasVisible) {
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
  viewer = new ViewerWindow({ title: "GeoJsonRead", width: 1120, height: 760, navigationToolbar: true });
  viewer.addControlPanel({
    title: "GeoJSON input",
    width: 560,
    controls: [
      { id: CONTROL.PRESET, type: "combo", label: "Preset", options: Object.keys(PRESETS), value: preset },
      { id: CONTROL.JSON, type: "text", label: "GeoJSON", value: inputJson },
      { id: CONTROL.READ, type: "button", text: "Read GeoJSON" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("GeoJSON details");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
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
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
