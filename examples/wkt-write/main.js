"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ShapeType,
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");

const INITIAL_EXTENT = extent(-13881577.0, 3763310.0, -12690421.0, 5160979.0);
const CONTROL = Object.freeze({ MODE: 1, CLEAR: 2 });
const LAYERS = Object.freeze({ Point: "Drawn Point", Polyline: "Drawn Polyline", Polygon: "Drawn Polygon" });
const STYLES = Object.freeze({
  Point: { pointColor: "#D95D39", lineColor: "#8C321D", pointSize: 13.0, lineWidth: 1.4 },
  Polyline: { lineColor: "#E4572E", lineWidth: 3.4, pointColor: "#F3A712", pointSize: 7.0 },
  Polygon: { fillColor: "#88D18A", fillOpacity: 128, lineColor: "#1F7A4D", lineWidth: 2.4 },
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let mode = "Point";
let drawingSketch = false;
const layerIndexes = { Point: -1, Polyline: -1, Polygon: -1 };

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

function activeTool() {
  if (mode === "Point") return ViewerTool.ADD_POINT;
  if (mode === "Polyline") return ViewerTool.ADD_POLYLINE;
  return ViewerTool.ADD_POLYGON;
}

function helpText() {
  if (mode === "Point") return "Click on the map to draw a point. WKT is written automatically.";
  if (mode === "Polyline") return "Click line vertices, then press Enter or double-click to finish. WKT is written automatically.";
  return "Click polygon vertices, then press Enter or double-click to finish. WKT is written automatically.";
}

function apiName() {
  if (mode === "Point") return "GisWktWriter::writePoint(shape)";
  if (mode === "Polyline") return "GisWktWriter::writePolyline(shape)";
  return "GisWktWriter::writePolygon(shape)";
}

function activateMode() {
  const index = layerIndexes[mode];
  if (index < 0) return;
  if (!viewer.isLayerEditing(index) && !viewer.beginEditLayer(index)) {
    throw new Error(`${LAYERS[mode]} could not enter edit mode.`);
  }
  if (!viewer.setActiveEditLayerIndex(index)) throw new Error(`${LAYERS[mode]} could not be activated.`);
  viewer.setTool(activeTool());
  viewer.setStatusText(helpText());
  showEmptyDetails();
}

function showEmptyDetails() {
  viewer.clearLog();
  viewer.appendLog(`${apiName()}\n\nDraw a geometry first. WKT will be written automatically.`);
}

function coordinatesFromGeoJson(geometry) {
  if (mode === "Point") return { point: { x: geometry.coordinates[0], y: geometry.coordinates[1] } };
  if (mode === "Polyline") {
    const coordinates = geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
    return { line: coordinates.map(([x, y]) => ({ x, y })) };
  }
  const rings = geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : geometry.coordinates;
  return { rings: rings.map((ring) => ring.map(([x, y]) => ({ x, y }))) };
}

function wktFromLastShape() {
  const index = layerIndexes[mode];
  if (viewer.layerFeatureCount(index) < 1) return "";
  const json = viewer.writeLayerLastShapeGeoJson(index);
  if (!json) return "";
  const geometry = JSON.parse(json);
  const coordinates = coordinatesFromGeoJson(geometry);
  if (mode === "Point") return viewer.writeWktPoint(coordinates.point.x, coordinates.point.y);
  if (mode === "Polyline") return viewer.writeWktLineString(coordinates.line);
  return viewer.writeWktPolygon(coordinates.rings);
}

function updateWkt() {
  const wkt = wktFromLastShape();
  if (!wkt) {
    showEmptyDetails();
    viewer.setStatusText(`No drawn ${mode.toLowerCase()} is available.`);
    return;
  }
  viewer.clearLog();
  viewer.appendLog([
    "WktWrite sample", "", "API", apiName(), "", "Selected geometry", mode,
    `Layer feature count: ${viewer.layerFeatureCount(layerIndexes[mode])}`, "", "Output WKT", wkt, "",
    "Workflow", "1. Choose geometry type.", "2. Draw geometry on map.",
    "3. WKT is written automatically when drawing finishes.",
  ].join("\n"));
  viewer.setStatusText(`${apiName()} wrote WKT from the drawn ${mode.toLowerCase()}.`);
}

function clearLayers() {
  drawingSketch = false;
  for (const key of Object.keys(layerIndexes)) {
    const index = layerIndexes[key];
    if (index < 0) continue;
    if (viewer.isLayerEditing(index)) viewer.rollbackEditLayer(index);
  }
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function handleMapMouseDown() {
  if (!controlsReady || viewer.getTool() !== activeTool()) return;
  if (mode !== "Point" && drawingSketch) return;

  const index = layerIndexes[mode];
  if (index < 0) return;
  if (viewer.layerFeatureCount(index) > 0) {
    viewer.rollbackEditLayer(index);
    viewer.beginEditLayer(index);
    viewer.setActiveEditLayerIndex(index);
    viewer.setTool(activeTool());
    viewer.invalidateRenderCache(false, true);
    viewer.refreshLayers();
    showEmptyDetails();
  }
  if (mode !== "Point") drawingSketch = true;
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  setImmediate(() => {
    if (!viewer) return;
    try {
      if (controlId === CONTROL.MODE) {
        mode = textValue;
        drawingSketch = false;
        clearLayers();
        activateMode();
      } else if (controlId === CONTROL.CLEAR) {
        clearLayers();
        activateMode();
        viewer.setStatusText("Drawn geometries cleared.");
      }
    } catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onViewerEvent(event) {
  if (event.eventType === ViewerEventType.MAP_MOUSE_DOWN) {
    try { handleMapMouseDown(); }
    catch (error) {
      viewer?.setStatusText(`Previous geometry could not be cleared: ${error.message}`);
      console.error(error?.stack || error);
    }
    return;
  }
  if (event.eventType !== ViewerEventType.LAYER_EDIT_STATE_CHANGED) return;
  drawingSketch = false;
  setImmediate(() => {
    if (!viewer) return;
    try { updateWkt(); }
    catch (error) {
      viewer.setStatusText(`WKT could not be written: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
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
  viewer = new ViewerWindow({ title: "WktWrite", width: 1100, height: 720, navigationToolbar: false });
  viewer.addControlPanel({
    title: "WKT writer",
    width: 420,
    controls: [
      { id: CONTROL.MODE, type: "combo", label: "Geometry", options: ["Point", "Polyline", "Polygon"], value: mode },
      { id: CONTROL.CLEAR, type: "button", text: "Clear" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Generated WKT");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  layerIndexes.Point = viewer.addEmptyVectorLayer(LAYERS.Point, ShapeType.POINT, STYLES.Point);
  layerIndexes.Polyline = viewer.addEmptyVectorLayer(LAYERS.Polyline, ShapeType.POLYLINE, STYLES.Polyline);
  layerIndexes.Polygon = viewer.addEmptyVectorLayer(LAYERS.Polygon, ShapeType.POLYGON, STYLES.Polygon);
  for (const key of Object.keys(layerIndexes)) {
    layerIndexes[key] = Number(viewer.layerInfoByName(LAYERS[key])?.index ?? -1);
    if (layerIndexes[key] < 0 || !viewer.setLayerCoordinateSystemPreset(layerIndexes[key], "EPSG:4326")) {
      throw new Error(`${LAYERS[key]} could not be configured as EPSG:4326.`);
    }
  }
  viewer.setEventCallback(onViewerEvent);
  viewer.setViewExtent(INITIAL_EXTENT);
  viewer.refreshLayers();
  controlsReady = true;
  activateMode();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  controlsReady = false;
  drawingSketch = false;
  for (const key of Object.keys(layerIndexes)) layerIndexes[key] = -1;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
