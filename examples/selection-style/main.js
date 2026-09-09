"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const {
  ViewerEventType,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");

const INITIAL_EXTENT = extent(-15, -9, 15, 11);
const DEFAULTS = Object.freeze({ selectedColor: "#F59E0B", selectedWidth: 4 });
const CONTROL = Object.freeze({ SELECTED_COLOR: 1, SELECTED_WIDTH: 2, CLEAR: 3, RESET: 4 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let resetting = false;
let values = { ...DEFAULTS };

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

function layerIndex(name) {
  return viewer.layersInfo().findIndex((layer) => layer.name === name);
}

function updateStatus() {
  viewer.setStatusText(
    `Tool: Select | Selected: ${viewer.selectedFeatureCount()} | `
    + `selectedLineColor=${values.selectedColor} | selectedLineWidth=${values.selectedWidth.toFixed(1)}`,
  );
}

function applySelectionStyle() {
  const polygonIndex = layerIndex("Selectable Polygons");
  const polylineIndex = layerIndex("Selectable Polyline");
  const pointIndex = layerIndex("Selectable Points");
  const selected = { selectedLineColor: values.selectedColor, selectedLineWidth: values.selectedWidth };
  if (polygonIndex >= 0) viewer.setLayerStyle(polygonIndex, {
    fillColor: "#F1D58A", fillOpacity: 180, lineColor: "#266D8F", lineWidth: 1.8, ...selected,
  });
  if (polylineIndex >= 0) viewer.setLayerStyle(polylineIndex, {
    lineColor: "#266D8F", lineWidth: 2.2, ...selected,
  });
  if (pointIndex >= 0) viewer.setLayerStyle(pointIndex, {
    pointColor: "#D95F35", pointSize: 10, ...selected,
  });
  viewer.refreshLayers();
  updateStatus();
}

function resetStyle() {
  resetting = true;
  try {
    values = { ...DEFAULTS };
    viewer.setControlValue(CONTROL.SELECTED_COLOR, values.selectedColor);
    viewer.setControlValue(CONTROL.SELECTED_WIDTH, values.selectedWidth);
  } finally {
    resetting = false;
  }
  applySelectionStyle();
}

function onControlChanged(controlId, numericValue, textValue) {
  if (controlId === CONTROL.CLEAR) {
    viewer.clearSelectedFeatures();
    updateStatus();
    return;
  }
  if (controlId === CONTROL.RESET) {
    resetStyle();
    return;
  }
  if (controlId === CONTROL.SELECTED_COLOR) values.selectedColor = textValue;
  else if (controlId === CONTROL.SELECTED_WIDTH) values.selectedWidth = numericValue;
  if (!resetting) applySelectionStyle();
}

function createLayers() {
  viewer.addPolygonLayer("Selectable Polygons", [
    [[-11, -4], [-4, -4], [-3, 2], [-8, 5], [-12, 1], [-11, -4]],
    [[2, -4], [10, -4], [12, 2], [6, 5], [1, 1], [2, -4]],
  ]);
  viewer.addPolylineLayer("Selectable Polyline", [[
    [-12, -7], [-6, -1], [0, -5.5], [6, -0.5], [13, -5],
  ]]);
  viewer.addPointLayer("Selectable Points", [[-8, 8], [0, 7], [8, 8]]);
  applySelectionStyle();
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
  viewer = new ViewerWindow({ title: "SelectionStyle", width: 1100, height: 720, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Selection Style",
    width: 230,
    controls: [
      { id: CONTROL.SELECTED_COLOR, type: "color", label: "Selected Line Color", value: DEFAULTS.selectedColor },
      { id: CONTROL.SELECTED_WIDTH, type: "number", label: "Selected Line Width", value: DEFAULTS.selectedWidth, minimum: 1, maximum: 16, step: 0.5, decimals: 1 },
      { id: CONTROL.CLEAR, type: "button", text: "Clear Selection" },
      { id: CONTROL.RESET, type: "button", text: "Reset Style" },
    ],
  }, onControlChanged);
  viewer.setTool(ViewerTool.SELECT);
  viewer.setEventCallback((event) => {
    if (event.eventType === ViewerEventType.SELECTION_CHANGED) updateStatus();
  });
  createLayers();
  viewer.show();
  viewer.processEvents();
  viewer.setViewExtent(INITIAL_EXTENT);
  viewer.processEvents();
  updateStatus();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
