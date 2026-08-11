"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const POLYGON_WKT = "POLYGON((-123.25 37.15, -122.15 36.95, -121.55 37.65, -122.05 38.35, -123.05 38.15, -123.25 37.15))";
const MULTIPOLYGON_WKT = "MULTIPOLYGON(((-123.25 37.15, -122.25 36.95, -121.85 37.65, -122.45 38.20, -123.15 37.95, -123.25 37.15)),((-121.60 36.75, -120.70 36.70, -120.45 37.35, -121.25 37.65, -121.60 36.75)))";
const POLYGON_LAYER_NAME = "WKT Polygon";
const CONTROL = Object.freeze({ MODE: 1, WKT: 2, READ: 3, RESET: 4 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let mode = "Polygon";
let inputWkt = POLYGON_WKT;
let controlsReady = false;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
}

function toWebMercator(point) {
  const originShift = 20037508.342789244;
  const longitude = Math.max(-180, Math.min(180, Number(point.x)));
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, Number(point.y)));
  return { x: longitude * originShift / 180, y: Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * originShift / Math.PI };
}

function paddedExtent(points, paddingRatio = 0.35, minimumPadding = 300000) {
  const xs = points.map((point) => Number(point.x));
  const ys = points.map((point) => Number(point.y));
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

function centroid(rings) {
  const points = rings.flat();
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}

function detailsText(wkt, rings, viewExtent, multiPolygon) {
  const points = rings.flat();
  const lonLatExtent = paddedExtent(points, 0, 0);
  const center = centroid(rings);
  const apiName = multiPolygon ? "GisWktReader::readMultiPolygon(wkt)" : "GisWktReader::readPolygon(wkt)";
  return [
    "WktReadPolygon sample", "", "API", apiName, "", "Input WKT", wkt, "",
    "Parsed polygon", `Parts/rings: ${rings.length}`, `Vertices: ${points.length}`,
    `Lon/lat extent: ${extentText(lonLatExtent, 6)}`, `Centroid: ${center.x.toFixed(6)}, ${center.y.toFixed(6)}`, "",
    "Displayed over OSM", "Input CRS: EPSG:4326", "Polygon layer / Viewer / OSM CRS: EPSG:3857",
    `WebMercator view extent: ${extentText(viewExtent, 3)}`, "", "Round-trip WKT", viewer.writeWktPolygon(rings),
  ].join("\n");
}

function showPolygon() {
  const multiPolygon = mode === "MultiPolygon";
  const wkt = inputWkt.trim();
  const parsed = viewer.readWktPolygon(wkt, multiPolygon);
  const rings = parsed.map((ring) => ring.map((item) => ({ x: Number(item.x), y: Number(item.y) })));
  if (!rings.length || rings.some((ring) => ring.length < 4 || ring.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) {
    throw new Error("A polygon must contain at least one valid closed ring.");
  }
  const projectedRings = rings.map((ring) => ring.map(toWebMercator));
  const viewExtent = paddedExtent(projectedRings.flat());
  viewer.removeLayerByName(POLYGON_LAYER_NAME);
  viewer.addPolygonLayer(POLYGON_LAYER_NAME, projectedRings, { fillColor: "#88D18A", fillOpacity: 130, lineColor: "#1F7A4D", lineWidth: 2.5 });
  if (!viewer.layerInfoByName(POLYGON_LAYER_NAME)?.name) throw new Error("WKT polygon layer could not be created.");
  viewer.setViewExtent(viewExtent);
  viewer.clearLog();
  viewer.appendLog(detailsText(wkt, rings, viewExtent, multiPolygon));
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  const apiName = multiPolygon ? "GisWktReader::readMultiPolygon" : "GisWktReader::readPolygon";
  viewer.setStatusText(`${apiName} parsed ${rings.length} ring(s) and ${rings.flat().length} vertices.`);
}

function readSafely() {
  try { showPolygon(); }
  catch (error) {
    viewer.removeLayerByName(POLYGON_LAYER_NAME);
    viewer.clearLog();
    viewer.appendLog(`WKT parse failed:\n${error.message}`);
    viewer.refreshLayers();
    viewer.setStatusText("WKT parse failed.");
  }
}

function resetInput() {
  inputWkt = mode === "MultiPolygon" ? MULTIPOLYGON_WKT : POLYGON_WKT;
  viewer.setControlValue(CONTROL.WKT, inputWkt);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.MODE) {
    mode = textValue;
    resetInput();
    readSafely();
  } else if (controlId === CONTROL.WKT) inputWkt = textValue;
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

function finishAndExit() { if (!closing) { closing = true; stop(); app.exit(0); } }

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "WktReadPolygon", width: 1120, height: 760, navigationToolbar: true });
  viewer.addControlPanel({
    title: "WKT polygon input", width: 480,
    controls: [
      { id: CONTROL.MODE, type: "combo", label: "Geometry", options: ["Polygon", "MultiPolygon"], value: mode },
      { id: CONTROL.WKT, type: "text", label: "WKT", value: inputWkt },
      { id: CONTROL.READ, type: "button", text: "Read Polygon" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("WKT polygon details");
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
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be destroyed. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
