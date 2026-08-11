"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const WORLD_LAYER_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const WORLD_STYLE = Object.freeze({
  fillColor: "#D7E5DF",
  lineColor: "#6D8C86",
  lineWidth: 1,
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

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; }
  catch { return 0; }
}

function sidecarPath(shapefilePath, extension) {
  return path.join(path.dirname(shapefilePath), `${path.parse(shapefilePath).name}${extension}`);
}

function typeName(value) {
  const names = ["String", "Integer", "Double", "Boolean", "DateTime"];
  if (typeof value === "number") return names[value] ?? String(value);
  return String(value ?? "Unknown");
}

function tableRow(values, widths) {
  return values.map((value, index) => {
    const text = String(value ?? "").replace(/\s+/g, " ");
    const width = widths[index];
    return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
  }).join(" | ").trimEnd();
}

function attributeRows(layerIndex, definitions, maximumRows) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
    const values = viewer.layerFeatureAttributes(layerIndex, rowIndex);
    if (!values || Object.keys(values).length === 0) break;
    rows.push(values);
  }

  const fields = definitions.map((definition) => String(definition.name ?? ""));
  if (rows.length === 0) return ["No attribute rows returned."];

  const widths = [4, ...fields.map((field) => Math.max(12, Math.min(24, field.length + 2)))];
  const output = [tableRow(["#", ...fields], widths), widths.map((width) => "-".repeat(width)).join("-+-")];
  rows.forEach((values, rowIndex) => {
    output.push(tableRow([rowIndex, ...fields.map((field) => values[field] ?? "")], widths));
  });
  return output;
}

function inspectionText(shapefilePath) {
  const info = viewer.layerInfo(0);
  const definitions = viewer.layerAttributeDefinitions(0);
  const schemaWidths = [24, 12, 8, 8];
  const schema = [
    tableRow(["Field", "Type", "Length", "Decimals"], schemaWidths),
    schemaWidths.map((width) => "-".repeat(width)).join("-+-"),
    ...definitions.map((definition) => tableRow([
      definition.name,
      typeName(definition.type),
      definition.length,
      definition.decimalCount,
    ], schemaWidths)),
  ];

  return [
    "ShapefileLoad sample",
    "",
    "API",
    "addLayer(path)",
    "layerInfo(index)",
    "layerAttributeDefinitions(index)",
    "layerFeatureAttributes(index, row)",
    "",
    "Loaded shapefile",
    shapefilePath,
    "",
    "Layer",
    `Name: ${info.name ?? "-"}`,
    `Shape type: ${info.shapeType ?? "Unknown"}`,
    `Feature count: ${viewer.layerFeatureCount(0)}`,
    `Field count: ${definitions.length}`,
    `Extent: ${JSON.stringify(info.extent ?? {})}`,
    "",
    "Sidecars",
    `.shp: ${fileSize(shapefilePath)} bytes`,
    `.shx: ${fileSize(sidecarPath(shapefilePath, ".shx"))} bytes`,
    `.dbf: ${fileSize(sidecarPath(shapefilePath, ".dbf"))} bytes`,
    "",
    "Attribute schema",
    ...schema,
    "",
    "First 12 attribute rows",
    ...attributeRows(0, definitions, 12),
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
    title: "ShapefileLoad",
    width: 1200,
    height: 760,
    navigationToolbar: false,
  });
  viewer.addLogPanel("Layer metadata, schema and first 12 rows");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing world shapefile sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const shapefilePath = await ensureSampleFile(
    WORLD_LAYER_URL,
    "world_4326.zip",
    "world_4326",
    "world_4326.shp",
  );
  if (!viewer) return;

  viewer.addLayer(shapefilePath);
  viewer.setLayerName(0, "World countries - EPSG:4326");
  viewer.setLayerStyle(0, WORLD_STYLE);
  viewer.clearLog();
  viewer.appendLog(inspectionText(shapefilePath));
  viewer.zoomToLayer(0);
  viewer.setStatusText(
    `ShapefileLoad opened ${viewer.layerFeatureCount(0)} features and `
    + `${viewer.layerAttributeDefinitions(0).length} fields.`,
  );
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
