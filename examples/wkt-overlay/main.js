"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const DEFAULT_WKT = Object.freeze({
  point: "POINT(-122.4194 37.7749)",
  line: "LINESTRING(-123.00 37.10, -122.55 37.65, -122.05 37.30, -121.55 38.10, -120.90 37.55)",
  polygon: "POLYGON((-123.25 37.15, -122.15 36.95, -121.55 37.65, -122.05 38.35, -123.05 38.15, -123.25 37.15))",
});
const CONTROL = Object.freeze({ POINT: 1, LINE: 2, POLYGON: 3, RENDER: 4, RESET: 5 });
const LAYER_NAMES = ["WKT Points", "WKT Lines", "WKT Polygons"];
const POINT_STYLE = Object.freeze({ pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 13.0, lineWidth: 1.4 });
const LINE_STYLE = Object.freeze({ lineColor: "#E4572E", lineWidth: 3.2, pointColor: "#F3A712", pointSize: 6.5 });
const POLYGON_STYLE = Object.freeze({ fillColor: "#88D18A", fillOpacity: 130, lineColor: "#1F7A4D", lineWidth: 2.4 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let pointWkt = DEFAULT_WKT.point;
let lineWkt = DEFAULT_WKT.line;
let polygonWkt = DEFAULT_WKT.polygon;

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

function paddedExtent(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMin = Math.min(...xs);
  const yMin = Math.min(...ys);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const paddingX = Math.max(350000, (xMax - xMin) * 0.45);
  const paddingY = Math.max(350000, (yMax - yMin) * 0.45);
  return extent(xMin - paddingX, yMin - paddingY, xMax + paddingX, yMax + paddingY);
}

function clearOverlayLayers() {
  for (const name of LAYER_NAMES) viewer.removeLayerByName(name);
}

function renderOverlay() {
  clearOverlayLayers();
  const details = [
    "WktOverlay sample", "", "API", "ReadWktPoint / ReadWktLineString / ReadWktPolygon",
    "AddPointLayer / AddPolylineLayer / AddPolygonLayer", "", "Rendered geometries",
  ];
  const allProjectedPoints = [];
  let renderedCount = 0;

  const point = viewer.readWktPoint(pointWkt.trim());
  if (!point) throw new Error("GisWktReader::readPoint returned no point.");
  const projectedPoint = toWebMercator(point);
  viewer.addPointLayer("WKT Points", [projectedPoint], POINT_STYLE);
  allProjectedPoints.push(projectedPoint);
  details.push(`Point: ${pointWkt.trim()}`);
  renderedCount += 1;

  const line = viewer.readWktLineString(lineWkt.trim())
    .map((item) => ({ x: Number(item.x), y: Number(item.y) }));
  if (line.length < 2) throw new Error("GisWktReader::readLineString returned no valid line.");
  const projectedLine = line.map(toWebMercator);
  viewer.addPolylineLayer("WKT Lines", [projectedLine], LINE_STYLE);
  allProjectedPoints.push(...projectedLine);
  details.push(`LineString vertices: ${line.length}`);
  renderedCount += 1;

  const rings = viewer.readWktPolygon(polygonWkt.trim(), false)
    .map((ring) => ring.map((item) => ({ x: Number(item.x), y: Number(item.y) })));
  if (!rings.length || rings.some((ring) => ring.length < 4)) {
    throw new Error("GisWktReader::readPolygon returned no valid polygon.");
  }
  const projectedRings = rings.map((ring) => ring.map(toWebMercator));
  viewer.addPolygonLayer("WKT Polygons", projectedRings, POLYGON_STYLE);
  allProjectedPoints.push(...projectedRings.flat());
  details.push(`Polygon rings: ${rings.length}; vertices: ${rings.reduce((sum, ring) => sum + ring.length, 0)}`);
  renderedCount += 1;

  for (const name of LAYER_NAMES) {
    if (!viewer.layerInfoByName(name)?.name) throw new Error(`${name} layer could not be created.`);
  }
  viewer.setViewExtent(paddedExtent(allProjectedPoints));
  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setStatusText(`Rendered ${renderedCount} WKT overlay geometries.`);
}

function renderSafely() {
  try { renderOverlay(); }
  catch (error) {
    clearOverlayLayers();
    viewer.clearLog();
    viewer.appendLog(`WKT overlay failed:\n${error.message}`);
    viewer.refreshLayers();
    viewer.setStatusText("WKT overlay failed.");
  }
}

function resetInput() {
  pointWkt = DEFAULT_WKT.point;
  lineWkt = DEFAULT_WKT.line;
  polygonWkt = DEFAULT_WKT.polygon;
  viewer.setControlValue(CONTROL.POINT, pointWkt);
  viewer.setControlValue(CONTROL.LINE, lineWkt);
  viewer.setControlValue(CONTROL.POLYGON, polygonWkt);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.POINT) pointWkt = textValue;
  else if (controlId === CONTROL.LINE) lineWkt = textValue;
  else if (controlId === CONTROL.POLYGON) polygonWkt = textValue;
  else if (controlId === CONTROL.RENDER) renderSafely();
  else if (controlId === CONTROL.RESET) { resetInput(); renderSafely(); }
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
  viewer = new ViewerWindow({ title: "WktOverlay", width: 1160, height: 760, navigationToolbar: true });
  viewer.addControlPanel({
    title: "WKT overlay input",
    width: 540,
    controls: [
      { id: CONTROL.POINT, type: "text", label: "Point WKT", value: pointWkt },
      { id: CONTROL.LINE, type: "text", label: "Line WKT", value: lineWkt },
      { id: CONTROL.POLYGON, type: "text", label: "Polygon WKT", value: polygonWkt },
      { id: CONTROL.RENDER, type: "button", text: "Render Overlay" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("WKT overlay details");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  controlsReady = true;
  renderSafely();
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
