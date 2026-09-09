"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const INITIAL_EXTENT = extent(-19.5, -14.2, 20.5, 18.9);
const DEFAULTS = Object.freeze({
  fillColor: "#F1D58A",
  lineColor: "#266D8F",
  lineWidth: 2,
  pointSize: 10,
});
const CONTROL = Object.freeze({ FILL_COLOR: 1, LINE_COLOR: 2, LINE_WIDTH: 3, POINT_SIZE: 4, RESET: 5 });

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

function applyStyle() {
  const polygonIndex = layerIndex("Styled Polygon");
  const polylineIndex = layerIndex("Styled Polyline");
  const pointIndex = layerIndex("Styled Points");
  if (polygonIndex >= 0) viewer.setLayerStyle(polygonIndex, {
    fillColor: values.fillColor,
    fillOpacity: 185,
    lineColor: values.lineColor,
    lineWidth: values.lineWidth,
  });
  if (polylineIndex >= 0) viewer.setLayerStyle(polylineIndex, {
    lineColor: values.lineColor,
    lineWidth: values.lineWidth,
  });
  if (pointIndex >= 0) viewer.setLayerStyle(pointIndex, {
    pointColor: "#D95F35",
    pointSize: values.pointSize,
  });
  viewer.refreshLayers();
}

function resetStyle() {
  resetting = true;
  try {
    values = { ...DEFAULTS };
    viewer.setControlValue(CONTROL.FILL_COLOR, values.fillColor);
    viewer.setControlValue(CONTROL.LINE_COLOR, values.lineColor);
    viewer.setControlValue(CONTROL.LINE_WIDTH, values.lineWidth);
    viewer.setControlValue(CONTROL.POINT_SIZE, values.pointSize);
  } finally {
    resetting = false;
  }
  applyStyle();
}

function onControlChanged(controlId, numericValue, textValue) {
  if (controlId === CONTROL.RESET) {
    resetStyle();
    return;
  }
  if (controlId === CONTROL.FILL_COLOR) values.fillColor = textValue;
  else if (controlId === CONTROL.LINE_COLOR) values.lineColor = textValue;
  else if (controlId === CONTROL.LINE_WIDTH) values.lineWidth = numericValue;
  else if (controlId === CONTROL.POINT_SIZE) values.pointSize = numericValue;
  if (!resetting) applyStyle();
}

function createLayers() {
  viewer.addPolygonLayer("Styled Polygon", [[
    [-8, -3], [1, -3], [3, 4], [-6, 6], [-10, 2], [-8, -3],
  ]]);
  viewer.addPolylineLayer("Styled Polyline", [[
    [-12, -7], [-5, -1], [1, -5], [8, 2], [13, -2],
  ]]);
  viewer.addPointLayer("Styled Points", [[-6, 9], [0, 8], [7, 7]]);
  applyStyle();
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
  viewer = new ViewerWindow({ title: "SimpleStyle", width: 1100, height: 720, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Style",
    width: 230,
    controls: [
      { id: CONTROL.FILL_COLOR, type: "color", label: "Fill Color", value: DEFAULTS.fillColor },
      { id: CONTROL.LINE_COLOR, type: "color", label: "Line Color", value: DEFAULTS.lineColor },
      { id: CONTROL.LINE_WIDTH, type: "number", label: "Line Width", value: DEFAULTS.lineWidth, minimum: 0.5, maximum: 12, step: 0.5, decimals: 1 },
      { id: CONTROL.POINT_SIZE, type: "number", label: "Point Size", value: DEFAULTS.pointSize, minimum: 2, maximum: 32, step: 0.5, decimals: 1 },
      { id: CONTROL.RESET, type: "button", text: "Reset Style" },
    ],
  }, onControlChanged);
  viewer.setTool(ViewerTool.PAN);
  createLayers();
  viewer.show();
  viewer.processEvents();
  viewer.setViewExtent(INITIAL_EXTENT);
  viewer.processEvents();
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
