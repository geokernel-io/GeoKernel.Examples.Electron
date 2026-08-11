"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const DEFAULT_WKT = Object.freeze({
  Point: "POINT(-122.4194 37.7749)",
  Polyline: "LINESTRING(-123.00 37.10, -122.55 37.65, -122.05 37.30, -121.55 38.10, -120.90 37.55)",
  Polygon: "POLYGON((-123.25 37.15, -122.15 36.95, -121.55 37.65, -122.05 38.35, -123.05 38.15, -123.25 37.15))",
});
const CONTROL = Object.freeze({ MODE: 1, WKT: 2, RUN: 3, RESET: 4 });
const LAYER_NAME = Object.freeze({ Point: "Roundtrip Point", Polyline: "Roundtrip Polyline", Polygon: "Roundtrip Polygon" });
const STYLE = Object.freeze({
  Point: { pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 13.0, lineWidth: 1.4 },
  Polyline: { lineColor: "#E4572E", lineWidth: 3.4, pointColor: "#F3A712", pointSize: 7.0 },
  Polygon: { fillColor: "#88D18A", fillOpacity: 130, lineColor: "#1F7A4D", lineWidth: 2.4 },
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let mode = "Point";
let inputWkt = DEFAULT_WKT.Point;

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

function apiNames() {
  if (mode === "Point") return ["GisWktReader::readPoint(wkt)", "GisWktWriter::writePoint(shape)"];
  if (mode === "Polyline") return ["GisWktReader::readLineString(wkt)", "GisWktWriter::writePolyline(shape)"];
  return ["GisWktReader::readPolygon(wkt)", "GisWktWriter::writePolygon(shape)"];
}

function removeResultLayers() {
  for (const name of Object.values(LAYER_NAME)) viewer.removeLayerByName(name);
}

function runRoundtrip() {
  const input = inputWkt.trim();
  if (!input) throw new Error("Input WKT is empty.");
  removeResultLayers();
  let output;
  let projectedPoints;
  let vertexCount;
  if (mode === "Point") {
    const point = viewer.readWktPoint(input);
    if (!point) throw new Error("GisWktReader::readPoint returned no point.");
    output = viewer.writeWktPoint(point.x, point.y);
    const projected = toWebMercator(point);
    projectedPoints = [projected];
    viewer.addPointLayer(LAYER_NAME.Point, projectedPoints, STYLE.Point);
    vertexCount = 1;
  } else if (mode === "Polyline") {
    const line = viewer.readWktLineString(input).map((point) => ({ x: Number(point.x), y: Number(point.y) }));
    if (line.length < 2) throw new Error("GisWktReader::readLineString returned no valid line.");
    output = viewer.writeWktLineString(line);
    projectedPoints = line.map(toWebMercator);
    viewer.addPolylineLayer(LAYER_NAME.Polyline, [projectedPoints], STYLE.Polyline);
    vertexCount = line.length;
  } else {
    const rings = viewer.readWktPolygon(input, false)
      .map((ring) => ring.map((point) => ({ x: Number(point.x), y: Number(point.y) })));
    if (!rings.length || rings.some((ring) => ring.length < 4)) {
      throw new Error("GisWktReader::readPolygon returned no valid polygon.");
    }
    output = viewer.writeWktPolygon(rings);
    const projectedRings = rings.map((ring) => ring.map(toWebMercator));
    projectedPoints = projectedRings.flat();
    viewer.addPolygonLayer(LAYER_NAME.Polygon, projectedRings, STYLE.Polygon);
    vertexCount = rings.reduce((sum, ring) => sum + ring.length, 0);
  }
  if (!output) throw new Error("GisWktWriter returned no WKT.");
  const layerInfo = viewer.layerInfoByName(LAYER_NAME[mode]);
  if (!layerInfo?.name) throw new Error(`${LAYER_NAME[mode]} layer could not be created.`);
  const [readApi, writeApi] = apiNames();
  viewer.setViewExtent(paddedExtent(projectedPoints));
  viewer.clearLog();
  viewer.appendLog([
    "WktRoundtrip sample", "", "API", `${readApi} -> ${writeApi}`, "", "Input WKT", input, "",
    "Output WKT", output, "", "Comparison", `Identical: ${input === output}`, `Vertex count: ${vertexCount}`, "",
    "Note", "GisWktWriter can normalize formatting even when geometry is unchanged.",
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setStatusText(input === output
    ? "Roundtrip completed. Output is identical."
    : "Roundtrip completed. Output is normalized by GisWktWriter.");
}

function runSafely() {
  try { runRoundtrip(); }
  catch (error) {
    removeResultLayers();
    viewer.clearLog();
    viewer.appendLog(`WKT roundtrip failed:\n${error.message}`);
    viewer.refreshLayers();
    viewer.setStatusText("WKT roundtrip failed.");
  }
}

function resetInput() {
  inputWkt = DEFAULT_WKT[mode];
  viewer.setControlValue(CONTROL.WKT, inputWkt);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.MODE) {
    mode = textValue;
    resetInput();
    runSafely();
  } else if (controlId === CONTROL.WKT) inputWkt = textValue;
  else if (controlId === CONTROL.RUN) runSafely();
  else if (controlId === CONTROL.RESET) { resetInput(); runSafely(); }
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
  viewer = new ViewerWindow({ title: "WktRoundtrip", width: 1120, height: 760, navigationToolbar: true });
  viewer.addControlPanel({
    title: "WKT roundtrip input",
    width: 500,
    controls: [
      { id: CONTROL.MODE, type: "combo", label: "Geometry", options: ["Point", "Polyline", "Polygon"], value: mode },
      { id: CONTROL.WKT, type: "text", label: "WKT", value: inputWkt },
      { id: CONTROL.RUN, type: "button", text: "Run Roundtrip" },
      { id: CONTROL.RESET, type: "button", text: "Reset" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Roundtrip details");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  controlsReady = true;
  runSafely();
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
