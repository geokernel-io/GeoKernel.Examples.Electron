"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  AttributeType,
  ShapeType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const SAMPLE_EXTENT = extent(-132, 18, -60, 55);
const GUIDE = Object.freeze([[-124, 30], [-113, 38], [-101, 32], [-89, 41], [-75, 34]]);
const COMMAND = Object.freeze({ ADD_POLYLINE: 1, RESET: 2, FULL_EXTENT: 3 });
const CONTROL = Object.freeze({ ENABLED: 1, TOLERANCE: 2 });
const WORLD_STYLE = Object.freeze({ fillColor: "#D8E5E1", fillOpacity: 130, lineColor: "#6F8883", lineWidth: 0.7 });
const LINE_STYLE = Object.freeze({
  lineColor: "#D95D39",
  lineWidth: 2.6,
  selectedLineColor: "#F59E0B",
  selectedLineWidth: 4,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let lineLayerIndex = -1;
let snappingEnabled = true;
let tolerance = 14;
let populating = false;

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

function refreshMap() {
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
}

function beginEditing() {
  if (lineLayerIndex < 0) throw new Error("Snapping Lines layer is missing.");
  if (!viewer.isLayerEditing(lineLayerIndex) && !viewer.beginEditLayer(lineLayerIndex)) {
    throw new Error("Snapping Lines layer could not enter edit mode.");
  }
  if (!viewer.setActiveEditLayerIndex(lineLayerIndex)) {
    throw new Error("Snapping Lines layer could not be activated.");
  }
}

function updateState(message) {
  const featureCount = viewer.layerFeatureCount(lineLayerIndex);
  const drawnLines = Math.max(0, featureCount - 1);
  const lines = [
    "Snapping APIs:",
    "- setEditSnappingEnabled(bool)",
    "- setEditSnappingTolerancePixels(double)",
    "",
    "Workflow:",
    "1. Add Polyline and draw near the guide line.",
    "2. Finish with Enter or double-click.",
    "3. Toggle snapping off and draw again.",
    "4. Change tolerance to compare the result.",
    "",
    `Snapping enabled: ${snappingEnabled}`,
    `Tolerance: ${tolerance.toFixed(0)} px`,
    `Drawn lines: ${drawnLines}`,
  ];
  viewer.clearLog();
  viewer.appendLog(lines.join("\n"));
  viewer.setStatusText(`${message} Snapping: ${snappingEnabled ? "ON" : "OFF"} | Tolerance: ${tolerance} px | Drawn lines: ${drawnLines}`);
}

function applySnapping(message) {
  viewer.setEditSnappingEnabled(snappingEnabled);
  viewer.setEditSnappingTolerancePixels(tolerance);
  updateState(message);
}

function activateAddPolyline() {
  beginEditing();
  viewer.setTool(ViewerTool.ADD_POLYLINE);
  updateState("Add Polyline active. Click vertices, then Enter or double-click.");
}

function resetGuide() {
  populating = true;
  try {
    if (viewer.isLayerEditing(lineLayerIndex) && !viewer.rollbackEditLayer(lineLayerIndex)) {
      throw new Error("Snapping Lines layer could not be reset.");
    }
    beginEditing();
    if (!viewer.addPolylineToEditLayer(lineLayerIndex, GUIDE, { Name: "Snap guide", Kind: "Snap target" })) {
      throw new Error("Snap guide could not be added.");
    }
  } finally {
    populating = false;
  }
  viewer.setTool(ViewerTool.ADD_POLYLINE);
  refreshMap();
  updateState("Guide line reset. Draw near it to test snapping.");
}

function handleCommand(commandId) {
  if (commandId === COMMAND.ADD_POLYLINE) activateAddPolyline();
  else if (commandId === COMMAND.RESET) resetGuide();
  else if (commandId === COMMAND.FULL_EXTENT) {
    viewer.setViewExtent(SAMPLE_EXTENT);
    updateState("Sample extent restored.");
  }
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    try { handleCommand(commandId); } catch (error) {
      viewer?.setStatusText(`Command failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
}

function onControlChanged(controlId, numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    if (controlId === CONTROL.ENABLED) snappingEnabled = textValue === "On";
    else if (controlId === CONTROL.TOLERANCE) tolerance = Math.max(1, Math.min(60, Math.trunc(numericValue)));
    applySnapping(controlId === CONTROL.ENABLED
      ? `Snapping ${snappingEnabled ? "enabled" : "disabled"}.`
      : `editSnappingTolerancePixels = ${tolerance}`);
  });
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
      if (Date.now() - viewerHiddenSince > 750) app.quit();
    }
  }, 16);
}

async function start() {
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "SnappingEnabled", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: COMMAND.ADD_POLYLINE, text: "Add Polyline" },
    { id: COMMAND.RESET, text: "Reset Guide" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addControlPanel({
    title: "Snapping",
    width: 245,
    controls: [
      { id: CONTROL.ENABLED, type: "combo", label: "Snapping", options: ["On", "Off"], value: "On" },
      { id: CONTROL.TOLERANCE, type: "number", label: "Tolerance px", value: 14, minimum: 1, maximum: 60, step: 1, decimals: 0 },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Snapping state");
  viewer.setEditSnappingEnabled(true);
  viewer.setEditSnappingTolerancePixels(14);
  viewer.setTool(ViewerTool.ADD_POLYLINE);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!viewer) return;
  viewer.addLayer(worldPath, { buildFeatureSource: true });
  viewer.setLayerName(0, "World");
  viewer.setLayerStyle(0, WORLD_STYLE);
  lineLayerIndex = viewer.addEmptyVectorLayer("Snapping Lines", ShapeType.POLYLINE, LINE_STYLE);
  lineLayerIndex = Number(viewer.layerInfoByName("Snapping Lines")?.index ?? -1);
  if (lineLayerIndex < 0) throw new Error("Snapping Lines layer could not be created.");
  for (const [name, length] of [["Name", 64], ["Kind", 32]]) {
    if (!viewer.addLayerAttributeDefinition(lineLayerIndex, name, AttributeType.STRING, length, 0)) {
      throw new Error(`${name} attribute definition could not be added.`);
    }
  }
  resetGuide();
  viewer.setViewExtent(SAMPLE_EXTENT);
  viewer.refreshLayers();
  viewer.processEvents();
  updateState("Draw near the guide line. Toggle snapping and tolerance to compare.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  lineLayerIndex = -1;
  snappingEnabled = true;
  tolerance = 14;
  populating = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
