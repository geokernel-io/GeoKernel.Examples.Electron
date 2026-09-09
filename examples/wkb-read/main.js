"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const PRESETS = Object.freeze({
  Point: "010100000050FC1873D79A5EC0D0D556EC2FE34240",
  LineString: "01020000000400000050FC1873D79A5EC0D0D556EC2FE34240789CA223B9785EC0ECC039234AAB42401DC9E53FA45F5EC043AD69DE714A434041F163CC5D2F5EC0D26F5F07CED14240",
  Polygon: "010300000001000000060000000000000000D05EC033333333339342409A99999999895EC09A999999997942403333333333635EC03333333333D342403333333333835EC0CDCCCCCCCC2C43403333333333C35EC033333333331343400000000000D05EC03333333333934240",
  MultiPolygon: "010600000002000000010300000001000000060000000000000000D05EC033333333339342400000000000905EC09A999999997942406666666666765EC03333333333D34240CDCCCCCCCC9C5EC09A999999991943409A99999999C95EC09A99999999F942400000000000D05EC03333333333934240010300000001000000050000006666666666665EC00000000000604240CDCCCCCCCC2C5EC09A99999999594240CDCCCCCCCC1C5EC0CDCCCCCCCCAC42400000000000505EC03333333333D342406666666666665EC00000000000604240",
});
const CONTROL = Object.freeze({ PRESET: 1, HEX: 2, READ: 3, RESET: 4 });
const LAYER_NAMES = ["WKB Point", "WKB LineString", "WKB Polygon"];
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
let inputHex = PRESETS.Point;

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

function parseHex(text) {
  const cleaned = String(text).replace(/\s+/g, "");
  if (!cleaned) throw new Error("WKB hex input is empty.");
  if (cleaned.length % 2 !== 0) throw new Error("WKB hex input must contain an even number of characters.");
  if (!/^[0-9A-Fa-f]+$/.test(cleaned)) throw new Error("WKB input must be hexadecimal.");
  return { cleaned, bytes: Buffer.from(cleaned, "hex") };
}

function toWebMercator(value) {
  const originShift = 20037508.342789244;
  const longitude = Math.max(-180, Math.min(180, Number(value.x)));
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, Number(value.y)));
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

function addGeometry(shapeClass, parts) {
  if (shapeClass === "Point") return viewer.addPointLayer(LAYER_NAMES[0], [parts[0][0]], STYLE.Point);
  if (shapeClass === "Polyline") return viewer.addPolylineLayer(LAYER_NAMES[1], parts, STYLE.Polyline);
  return viewer.addPolygonLayer(LAYER_NAMES[2], parts, STYLE.Polygon);
}

function readWkb() {
  const { cleaned, bytes } = parseHex(inputHex);
  const geometry = viewer.readWkbGeometry(bytes);
  const shapeClass = String(geometry.shapeClass || "");
  const lonLatParts = (geometry.parts || []).map((part) =>
    part.map((value) => ({ x: Number(value.x), y: Number(value.y) })));
  if (!["Point", "Polyline", "Polygon"].includes(shapeClass) || !lonLatParts.length || lonLatParts.some((part) => !part.length)) {
    throw new Error("GisWkbReader::read returned an empty or unsupported shape.");
  }

  clearGeometryLayers();
  const lonLatPoints = lonLatParts.flat();
  const projectedParts = lonLatParts.map((part) => part.map(toWebMercator));
  const viewExtent = bounds(projectedParts.flat(), 0.35, 250000);
  if (addGeometry(shapeClass, projectedParts) < 0) throw new Error(`WKB ${shapeClass} layer could not be created.`);
  viewer.setViewExtent(viewExtent);
  viewer.clearLog();
  viewer.appendLog([
    "WkbRead sample", "", "API", "GisWkbReader::read(byteArray)", "", "Input WKB",
    `Hex characters: ${cleaned.length}`, `Byte count: ${bytes.length}`, "", "Parsed shape",
    `Shape class: ${preset === "MultiPolygon" ? "MultiPolygon" : shapeClass}`,
    `Parts: ${lonLatParts.length}`, `Vertices: ${lonLatPoints.length}`,
    `Lon/lat extent: ${extentText(bounds(lonLatPoints), 6)}`, "", "Displayed over OSM",
    "Layer CRS: EPSG:4326", "Viewer/OSM CRS: EPSG:3857",
    `WebMercator view extent: ${extentText(viewExtent, 3)}`, "", "Input hex", cleaned,
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setStatusText(`GisWkbReader::read parsed ${preset} from ${bytes.length} bytes.`);
}

function readSafely() {
  try { readWkb(); }
  catch (error) {
    clearGeometryLayers();
    viewer.clearLog();
    viewer.appendLog(`WKB parse failed:\n${error.message}`);
    viewer.refreshLayers();
    viewer.setStatusText("WKB parse failed.");
  }
}

function resetInput() {
  inputHex = PRESETS[preset];
  viewer.setControlValue(CONTROL.HEX, inputHex);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.PRESET) {
    preset = textValue;
    resetInput();
    readSafely();
  } else if (controlId === CONTROL.HEX) inputHex = textValue;
  else if (controlId === CONTROL.READ) readSafely();
  else if (controlId === CONTROL.RESET) { resetInput(); readSafely(); }
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
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

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "WkbRead", width: 1120, height: 760, navigationToolbar: true });
  viewer.addControlPanel({
    title: "WKB input",
    width: 560,
    controls: [
      { id: CONTROL.PRESET, type: "combo", label: "Preset", options: Object.keys(PRESETS), value: preset },
      { id: CONTROL.HEX, type: "text", label: "WKB hex", value: inputHex },
      { id: CONTROL.READ, type: "button", text: "Read WKB" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("WKB details");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  controlsReady = true;
  readWkb();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
