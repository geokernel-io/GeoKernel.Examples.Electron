"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");
const { attributeRows, schemaRows } = require("../common/file-inspection");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/geog_25000_dxf.zip";
const DXF_STYLE = Object.freeze({
  fillColor: "#D7E5DF",
  fillOpacity: 89,
  lineColor: "#2E6F91",
  lineWidth: 1.25,
  pointColor: "#D95D39",
  pointSize: 6,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll")
      : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function inspectionText(dxfPath) {
  const info = viewer.layerInfo(0);
  const definitions = viewer.layerAttributeDefinitions(0);
  return [
    "DxfLoad sample",
    "",
    "API",
    "addLayer(path)",
    "layerInfo(index)",
    "layerAttributeDefinitions(index)",
    "layerFeatureAttributes(index, row)",
    "",
    "Loaded CAD DXF",
    dxfPath,
    "",
    "Layer",
    `Name: ${info.name ?? "-"}`,
    `Shape type: ${info.shapeType ?? "Unknown"}`,
    `Memory shape count: ${viewer.layerFeatureCount(0)}`,
    "GisLayerDXF parses supported DXF entities into an in-memory vector layer.",
    "Supported entities include POINT, TEXT, MTEXT, LINE, LWPOLYLINE, POLYLINE, CIRCLE and ARC.",
    `Field count: ${definitions.length}`,
    `Extent: ${JSON.stringify(info.extent ?? {})}`,
    "",
    "File",
    `.dxf: ${fs.statSync(dxfPath).size} bytes (exists)`,
    "",
    "Attribute schema",
    ...schemaRows(definitions),
    "",
    "First 12 attribute rows",
    ...attributeRows(viewer, 0, definitions, 12),
  ].join("\n");
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
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "DxfLoad",
    width: 1200,
    height: 760,
    navigationToolbar: false,
  });
  viewer.addLogPanel("Layer metadata, schema and first 12 rows");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing DXF sample data...");
  viewer.show();
  viewer.processEvents();

  const dxfPath = await ensureSampleFile(
    SAMPLE_URL,
    "geog_25000_dxf.zip",
    "geog_25000_dxf",
    "geog_25000.dxf",
  );
  if (!viewer) return;

  viewer.addLayer(dxfPath);
  viewer.setLayerName(0, "Geography 1:25000 DXF");
  viewer.setLayerStyle(0, DXF_STYLE);
  viewer.clearLog();
  viewer.appendLog(inspectionText(dxfPath));
  viewer.processEvents();
  viewer.zoomToLayer(0);
  viewer.setStatusText(
    `DxfLoad opened ${viewer.layerFeatureCount(0)} features and `
    + `${viewer.layerAttributeDefinitions(0).length} fields.`,
  );
  viewer.show();
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
