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

const LAYER_NAME = "Drawn Polygon";
const INITIAL_EXTENT = extent(-13881577.0, 3763310.0, -12690421.0, 5160979.0);
const COMMAND = Object.freeze({ ADD_POLYGON: 1, CLEAR: 2, FULL_EXTENT: 3 });
const POLYGON_STYLE = Object.freeze({
  fillColor: "#88D18A",
  fillOpacity: 128,
  lineColor: "#1F7A4D",
  lineWidth: 2.4,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let polygonLayerIndex = -1;

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

function showEmptyDetails() {
  viewer.clearLog();
  viewer.appendLog(
    "GisGeoJsonWriter::writePolygonString(shape)\n\n" +
    "Draw a polygon on the map. The GeoJSON string will appear here.",
  );
}

function activatePolygonTool() {
  if (polygonLayerIndex < 0) throw new Error("Editable polygon layer is not in the viewer.");
  if (!viewer.isLayerEditing(polygonLayerIndex) && !viewer.beginEditLayer(polygonLayerIndex)) {
    throw new Error("Polygon layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(polygonLayerIndex)) throw new Error("Polygon layer could not be activated.");
  viewer.setTool(ViewerTool.ADD_POLYGON);
  viewer.setStatusText("Add Polygon active. Finish with Enter or double-click.");
}

function clearPolygon() {
  if (polygonLayerIndex < 0) return;
  if (viewer.isLayerEditing(polygonLayerIndex) && !viewer.rollbackEditLayer(polygonLayerIndex)) {
    throw new Error("Polygon layer could not be cleared.");
  }
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  showEmptyDetails();
  activatePolygonTool();
  viewer.setStatusText("Polygon cleared.");
}

function writeGeoJson() {
  if (polygonLayerIndex < 0 || viewer.layerFeatureCount(polygonLayerIndex) < 1) {
    showEmptyDetails();
    return;
  }
  const geoJson = viewer.writeLayerLastShapeGeoJson(polygonLayerIndex);
  if (!geoJson) throw new Error("GisGeoJsonWriter returned no GeoJSON.");
  const document = JSON.parse(geoJson);
  const rings = Array.isArray(document.coordinates) ? document.coordinates : [];
  const points = rings.flat();
  if (!rings.length || !points.length) throw new Error("Written polygon GeoJSON contains no coordinates.");
  const xs = points.map((point) => Number(point[0]));
  const ys = points.map((point) => Number(point[1]));
  const lonLatExtent = `(${Math.min(...xs).toFixed(6)}, ${Math.min(...ys).toFixed(6)}) - ` +
    `(${Math.max(...xs).toFixed(6)}, ${Math.max(...ys).toFixed(6)})`;
  viewer.clearLog();
  viewer.appendLog([
    "GeoJsonWrite sample", "", "API", "GisGeoJsonWriter::writePolygonString(shape)", "",
    "Drawn polygon", `Rings: ${rings.length}`, `Vertices: ${points.length}`, `Lon/lat extent: ${lonLatExtent}`, "",
    "Output GeoJSON", geoJson, "", "Workflow", "1. Click polygon vertices on the map.",
    "2. Press Enter or double-click to finish.", "3. GeoJSON is written automatically.",
  ].join("\n"));
  viewer.setStatusText("GisGeoJsonWriter::writePolygonString wrote polygon GeoJSON.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POLYGON) activatePolygonTool();
  else if (commandId === COMMAND.CLEAR) clearPolygon();
  else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(INITIAL_EXTENT);
    viewer.setStatusText("Sample extent restored.");
  }
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    try { handleCommand(commandId); }
    catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onViewerEvent(event) {
  if (event.eventType !== ViewerEventType.LAYER_EDIT_STATE_CHANGED) return;
  setImmediate(() => {
    if (!viewer || polygonLayerIndex < 0 || viewer.layerFeatureCount(polygonLayerIndex) < 1) return;
    try {
      viewer.invalidateRenderCache(false, true);
      viewer.refreshLayers();
      writeGeoJson();
    } catch (error) {
      viewer.setStatusText(`GeoJSON could not be written: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "GeoJsonWrite", width: 1100, height: 720, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POLYGON, text: "Add Polygon" },
    { id: COMMAND.CLEAR, text: "Clear", separatorBefore: true },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent", separatorBefore: true },
  ], onCommand);
  viewer.addLogPanel("Generated GeoJSON");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  viewer.addOpenStreetMapLayer(true);
  if (viewer.layerCount() === 0) throw new Error("OpenStreetMap layer could not be created.");
  viewer.addEmptyVectorLayer(LAYER_NAME, ShapeType.POLYGON, POLYGON_STYLE);
  polygonLayerIndex = Number(viewer.layerInfoByName(LAYER_NAME)?.index ?? -1);
  if (polygonLayerIndex < 0) throw new Error("Drawn Polygon layer could not be created.");
  if (!viewer.setLayerCoordinateSystemPreset(polygonLayerIndex, "EPSG:4326")) {
    throw new Error("Drawn Polygon CRS could not be set to EPSG:4326.");
  }
  viewer.setEventCallback(onViewerEvent);
  viewer.setViewExtent(INITIAL_EXTENT);
  showEmptyDetails();
  activatePolygonTool();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  polygonLayerIndex = -1;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
