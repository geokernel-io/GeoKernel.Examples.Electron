"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const TAB_SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/paris_tab.zip";
const TAB_STYLE = Object.freeze({
  fillColor: "#D7E5DF",
  fillOpacity: 184,
  lineColor: "#6D8C86",
  lineWidth: 1.1,
  pointColor: "#D95D39",
  pointSize: 7,
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

function sidecarPath(tabPath, extension) {
  return path.join(path.dirname(tabPath), `${path.parse(tabPath).name}${extension}`);
}

function sidecarLine(tabPath, extension) {
  const candidate = sidecarPath(tabPath, extension);
  if (!fs.existsSync(candidate)) return `${extension}: 0 bytes (missing)`;
  return `${extension}: ${fs.statSync(candidate).size} bytes (exists)`;
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

function attributeRows(definitions, maximumRows) {
  const fields = definitions.map((definition) => String(definition.name ?? ""));
  const rows = [];
  for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
    const values = viewer.layerFeatureAttributes(0, rowIndex);
    if (!values || Object.keys(values).length === 0) break;
    rows.push(values);
  }
  if (rows.length === 0) return ["No attribute rows returned."];

  const widths = [4, ...fields.map((field) => Math.max(12, Math.min(24, field.length + 2)))];
  return [
    tableRow(["#", ...fields], widths),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map((values, rowIndex) => tableRow([
      rowIndex,
      ...fields.map((field) => values[field] ?? ""),
    ], widths)),
  ];
}

function inspectionText(tabPath) {
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
    "TabLoad sample",
    "",
    "API",
    "addLayer(path)",
    "layerInfo(index)",
    "layerAttributeDefinitions(index)",
    "layerFeatureAttributes(index, row)",
    "",
    "Loaded MapInfo TAB",
    tabPath,
    "",
    "Layer",
    `Name: ${info.name ?? "-"}`,
    `Shape type: ${info.shapeType ?? "Unknown"}`,
    `Feature count: ${viewer.layerFeatureCount(0)}`,
    `Field count: ${definitions.length}`,
    `Extent: ${JSON.stringify(info.extent ?? {})}`,
    "",
    "Sidecars",
    sidecarLine(tabPath, ".tab"),
    sidecarLine(tabPath, ".dat"),
    sidecarLine(tabPath, ".map"),
    sidecarLine(tabPath, ".id"),
    sidecarLine(tabPath, ".dbf"),
    "",
    "Attribute schema",
    ...schema,
    "",
    "First 12 attribute rows",
    ...attributeRows(definitions, 12),
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
    title: "TabLoad",
    width: 1200,
    height: 760,
    navigationToolbar: false,
  });
  viewer.addLogPanel("Layer metadata, schema and first 12 rows");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing MapInfo TAB sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const tabPath = await ensureSampleFile(
    TAB_SAMPLE_URL,
    "paris_tab.zip",
    "paris_tab",
    "paris.tab",
  );
  if (!viewer) return;

  viewer.addLayer(tabPath);
  viewer.setLayerName(0, "Paris TAB");
  viewer.setLayerStyle(0, TAB_STYLE);
  viewer.clearLog();
  viewer.appendLog(inspectionText(tabPath));
  viewer.zoomToLayer(0);
  viewer.setStatusText(
    `TabLoad opened ${viewer.layerFeatureCount(0)} features and `
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
