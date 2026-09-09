"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ShapeType, ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const POINT_STYLE = { pointColor: "#D95F35", pointSize: 7 };
const LINE_STYLE = { lineColor: "#266D8F", lineWidth: 2.2 };
const POLYGON_STYLE = { fillColor: "#F1D58A", fillOpacity: 150, lineColor: "#9A7A1F", lineWidth: 1.5 };
let points = [], lines = [], polygons = [];
let pointCursor = 0, lineCursor = 1, polygonCursor = 1;
let viewer = null, keeperWindow = null, eventPump = null, viewerWasVisible = false, viewerHiddenSince = 0;

function route(offset) { return [[-122.4194 + offset, 37.7749], [-118.2437 + offset, 34.0522], [-112.0740 + offset, 33.4484], [-104.9903 + offset, 39.7392]]; }
function region(offset) { return [[-101 + offset, 30], [-91 + offset, 30], [-89 + offset, 37], [-96 + offset, 42], [-103 + offset, 38], [-101 + offset, 30]]; }
function generatedPoint(index) {
  const column = index % 12, row = Math.floor(index / 12);
  return [-124 + column * 4.8 + (row % 3) * 0.35, 25 + row * 3.2 + (column % 4) * 0.25];
}
function updateStatus(message) { viewer.setStatusText(`${message} Memory features - points: ${points.length} | lines: ${lines.length} | polygons: ${polygons.length}`); }
function rebuildMemoryLayers() {
  for (const name of ["Memory Cities", "Memory Routes", "Memory Regions"]) viewer.removeLayerByName(name);
  viewer.addEmptyVectorLayer("Memory Regions", ShapeType.POLYGON, POLYGON_STYLE);
  viewer.addEmptyVectorLayer("Memory Routes", ShapeType.POLYLINE, LINE_STYLE);
  viewer.addEmptyVectorLayer("Memory Cities", ShapeType.POINT, POINT_STYLE);
  viewer.beginEditLayer(2); for (const polygon of polygons) viewer.addPolygonToEditLayer(2, polygon); viewer.commitEditLayer(2);
  viewer.beginEditLayer(1); for (const line of lines) viewer.addPolylineToEditLayer(1, line); viewer.commitEditLayer(1);
  viewer.beginEditLayer(0); for (const point of points) viewer.addPointToEditLayer(0, point[0], point[1]); viewer.commitEditLayer(0);
  viewer.refreshLayers();
}
function appendPoint(point) {
  if (!viewer.beginEditLayer(0)) throw new Error("Memory Cities edit session could not be started.");
  if (!viewer.addPointToEditLayer(0, point[0], point[1]) || !viewer.commitEditLayer(0)) throw new Error("Point could not be added.");
  viewer.refreshLayers();
}
function appendLine(line) {
  if (!viewer.beginEditLayer(1)) throw new Error("Memory Routes edit session could not be started.");
  if (!viewer.addPolylineToEditLayer(1, line) || !viewer.commitEditLayer(1)) throw new Error("Line could not be added.");
  viewer.refreshLayers();
}
function appendPolygon(polygon) {
  if (!viewer.beginEditLayer(2)) throw new Error("Memory Regions edit session could not be started.");
  if (!viewer.addPolygonToEditLayer(2, polygon) || !viewer.commitEditLayer(2)) throw new Error("Polygon could not be added.");
  viewer.refreshLayers();
}
function resetMemoryLayers() {
  points = [[-122.4194, 37.7749], [-118.2437, 34.0522]]; lines = [route(0)]; polygons = [region(0)];
  pointCursor = 0; lineCursor = 1; polygonCursor = 1; rebuildMemoryLayers(); updateStatus("Memory layers reset.");
}
function handleCommand(id) {
  if (id === 1) { const point = generatedPoint(pointCursor++); appendPoint(point); points.push(point); updateStatus("Point added."); }
  if (id === 2) { const line = route(lineCursor++ * 2); appendLine(line); lines.push(line); updateStatus("Line added."); }
  if (id === 3) { const polygon = region(polygonCursor++ * 5); appendPolygon(polygon); polygons.push(polygon); updateStatus("Polygon added."); }
  if (id === 4) resetMemoryLayers();
  if (id === 5) viewer.fullExtent();
}
function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  if (![path.join(binDir, "platforms", "qwindows.dll"), path.join(binDir, "plugins", "platforms", "qwindows.dll")].some(fs.existsSync)) throw new Error(`GeoKernel Electron runtime is missing qwindows.dll: ${binDir}`);
}
function startEventPump() {
  eventPump = setInterval(() => { if (!viewer) return; viewer.processEvents(); if (viewer.isVisible()) { viewerWasVisible = true; viewerHiddenSince = 0; return; } if (viewerWasVisible && viewerHiddenSince === 0) viewerHiddenSince = Date.now(); if (viewerWasVisible && Date.now() - viewerHiddenSince > 750) app.quit(); }, 16);
}
async function start() {
  verifyQtPlatformPlugin();
  const worldPath = await ensureSampleFile("https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip", "world_4326.zip", "world_4326", "world_4326.shp");
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "InMemoryLayers", width: 1200, height: 800, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Add Point" }, { id: 2, text: "Add Line" }, { id: 3, text: "Add Polygon" },
    { id: 4, text: "Clear Memory Layers", separatorBefore: true }, { id: 5, text: "Full Extent" },
  ], handleCommand);
  viewer.addLayer(worldPath); viewer.setLayerName(0, "World"); viewer.setLayerStyle(0, { fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#6F8883", lineWidth: 0.7 });
  resetMemoryLayers(); viewer.setViewExtent(extent(-130, 20, -65, 52)); viewer.setTool(ViewerTool.PAN); viewer.show(); viewer.processEvents(); startEventPump();
}
function stop() { if (eventPump) clearInterval(eventPump); eventPump = null; if (viewer) viewer.close(); viewer = null; if (keeperWindow) keeperWindow.close(); keeperWindow = null; }
module.exports = { start, stop };
