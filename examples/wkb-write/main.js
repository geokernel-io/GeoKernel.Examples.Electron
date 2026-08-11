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

function apiName() {
  if (mode === "Point") return "GisWkbWriter::writePoint(shape)";
  if (mode === "Polyline") return "GisWkbWriter::writePolyline(shape)";
  return "GisWkbWriter::writePolygon(shape)";
}

function helpText() {
  if (mode === "Point") return "Click on the map to draw a point. WKB is written automatically.";
  if (mode === "Polyline") return "Click line vertices, then press Enter or double-click to finish.";
  return "Click polygon vertices, then press Enter or double-click to finish.";
}

function showEmptyDetails() {
  viewer.clearLog();
  viewer.appendLog(`${apiName()}\n\nDraw a geometry first. WKB will be written automatically.`);
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

function spacedHex(bytes) {
  return Buffer.from(bytes).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") ?? "";
}

function updateWkb() {
  const index = layerIndexes[mode];
  if (viewer.layerFeatureCount(index) < 1) return;
  const bytes = viewer.writeLayerLastShapeWkb(index);
  if (!bytes.length) throw new Error("GisWkbWriter returned an empty byte array.");
  viewer.clearLog();
  viewer.appendLog([
    "WkbWrite sample", "", "API", apiName(), "", "Selected geometry", mode,
    `Layer feature count: ${viewer.layerFeatureCount(index)}`, "", "Output WKB",
    `Byte count: ${bytes.length}`, `Endian: ${bytes[0] === 1 ? "little endian" : "big endian"}`,
    "", "Hex view", spacedHex(bytes), "", "Workflow", "1. Choose geometry type.",
    "2. Draw geometry on map.", "3. WKB binary is written automatically when drawing finishes.",
  ].join("\n"));
  viewer.setStatusText(`${apiName()} wrote ${bytes.length} WKB bytes.`);
}

function clearLayers() {
  for (const key of Object.keys(layerIndexes)) {
    const index = layerIndexes[key];
    if (index >= 0 && viewer.isLayerEditing(index)) viewer.rollbackEditLayer(index);
  }
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  setImmediate(() => {
    if (!viewer) return;
    try {
      if (controlId === CONTROL.MODE) {
        mode = textValue;
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
  if (event.eventType !== ViewerEventType.LAYER_EDIT_STATE_CHANGED) return;
  setImmediate(() => {
    if (!viewer) return;
    try { updateWkb(); }
    catch (error) {
      viewer.setStatusText(`WKB could not be written: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
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
  viewer = new ViewerWindow({ title: "WkbWrite", width: 1100, height: 720, navigationToolbar: false });
  viewer.addControlPanel({
    title: "WKB writer",
    width: 420,
    controls: [
      { id: CONTROL.MODE, type: "combo", label: "Geometry", options: ["Point", "Polyline", "Polygon"], value: mode },
      { id: CONTROL.CLEAR, type: "button", text: "Clear" },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Generated WKB");
  viewer.setTool(ViewerTool.PAN);
  if (!viewer.setCoordinateSystemPreset("EPSG:3857")) throw new Error("Viewer CRS could not be set to EPSG:3857.");
  if (viewer.writeWkbPoint(-122.4194, 37.7749).length === 0) {
    throw new Error("GisWkbWriter runtime bridge returned an empty byte array.");
  }
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
  controlsReady = false;
  for (const key of Object.keys(layerIndexes)) layerIndexes[key] = -1;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
