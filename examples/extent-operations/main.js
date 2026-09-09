"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ShapeType,
  ViewerTool,
  ViewerWindow,
  extent,
  extentContains,
  extentExpand,
  extentInflate,
  extentIntersects,
  findBinDir,
  point,
} = require("geokernel-electron");

const FULL_EXTENT = extent(-5.8, -3.0, 5.4, 3.6);
const BASE = extent(-4.4, -1.8, 0.8, 1.8);
const OTHER = extent(-0.8, -0.6, 4.2, 2.6);
const INSIDE = point(-2.0, 0.4);
const OUTSIDE = point(2.8, -1.2);

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

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

function extentRing(value) {
  return [
    [value.xMin, value.yMin], [value.xMax, value.yMin], [value.xMax, value.yMax],
    [value.xMin, value.yMax], [value.xMin, value.yMin],
  ];
}

function extentStyle(fillColor, lineColor, fillOpacity, lineWidth) {
  return {
    fillColor, lineColor, fillOpacity, lineWidth, showLabels: true, labelField: "LABEL",
    labelFontSize: 11, labelColor: "#202124", labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
  };
}

function pointStyle(pointColor, lineColor) {
  return {
    pointColor, pointSize: 11, lineColor, lineWidth: 1, showLabels: true, labelField: "LABEL",
    labelFontSize: 10, labelColor: lineColor, labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
  };
}

function addPolygon(name, value, label, style) {
  const index = viewer.addEmptyVectorLayer(name, ShapeType.POLYGON, style);
  if (index < 0 || !viewer.beginEditLayer(index)) throw new Error(`${name} layer could not be created.`);
  if (!viewer.addPolygonToEditLayer(index, extentRing(value), { LABEL: label }) || !viewer.commitEditLayer(index)) {
    throw new Error(`${name} extent could not be added.`);
  }
}

function addPoint(name, value, label, style) {
  const index = viewer.addEmptyVectorLayer(name, ShapeType.POINT, style);
  if (index < 0 || !viewer.beginEditLayer(index)) throw new Error(`${name} layer could not be created.`);
  if (!viewer.addPointToEditLayer(index, value.x, value.y, { LABEL: label }) || !viewer.commitEditLayer(index)) {
    throw new Error(`${name} point could not be added.`);
  }
}

function extentText(value) {
  return `(${value.xMin.toFixed(2)}, ${value.yMin.toFixed(2)}) - (${value.xMax.toFixed(2)}, ${value.yMax.toFixed(2)}), w=${(value.xMax - value.xMin).toFixed(2)}, h=${(value.yMax - value.yMin).toFixed(2)}`;
}

function renderScene() {
  const expanded = extentExpand(BASE, OTHER);
  const inflated = extentInflate(BASE, 0.9, 0.7);

  addPolygon("Expanded", expanded, "A.expand(B)", extentStyle("#CDE7D8", "#2A9D8F", 55, 3.0));
  addPolygon("Inflated", inflated, "A.inflate(0.9, 0.7)", extentStyle("#E6D5F7", "#7B2CBF", 35, 3.0));
  addPolygon("Base A", BASE, "A", extentStyle("#BFD7EA", "#2F80C2", 90, 2.2));
  addPolygon("Other B", OTHER, "B", extentStyle("#F6D6AD", "#D95D39", 90, 2.2));
  addPoint("Inside Point", INSIDE, "contains: true", pointStyle("#2A9D8F", "#145A4B"));
  addPoint("Outside Point", OUTSIDE, "contains: false", pointStyle("#C1121F", "#7A0010"));

  viewer.clearLog();
  viewer.appendLog([
    "GisExtent operations", "", `A: ${extentText(BASE)}`, `B: ${extentText(OTHER)}`, "",
    `A.expand(B): ${extentText(expanded)}`, `A.inflate(0.9, 0.7): ${extentText(inflated)}`, "",
    `A.intersects(B): ${extentIntersects(BASE, OTHER)}`, `A.contains(inside point): ${extentContains(BASE, INSIDE)}`,
    `A.contains(outside point): ${extentContains(BASE, OUTSIDE)}`, "", "Visual guide:",
    "Blue: base extent A", "Orange: extent B", "Green: A expanded to include B", "Purple: A inflated by dx/dy",
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(FULL_EXTENT);
  viewer.setStatusText("Extent operations rendered.");
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
  viewer = new ViewerWindow({ title: "ExtentOperations", width: 1040, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([{ id: 1, text: "Full Extent" }], (id) => {
    if (id === 1) viewer.setViewExtent(FULL_EXTENT);
  });
  viewer.addLogPanel("Extent operation details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  renderScene();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
