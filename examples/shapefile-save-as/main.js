"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const WORLD_LAYER_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const COMMAND = Object.freeze({ SAVE_AS: 1, FULL_EXTENT: 2 });
const SIDECAR_EXTENSIONS = Object.freeze([".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix"]);
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
let sourcePath = "";
let sourceLayerIndex = -1;
let saving = false;

function outputPath() {
  return path.join(__dirname, "ShapefileSaveAsData", "world_4326_copy.shp");
}

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

function sidecarPath(shapefilePath, extension) {
  return path.join(path.dirname(shapefilePath), `${path.parse(shapefilePath).name}${extension}`);
}

function removeExistingOutput(shapefilePath) {
  const resolvedDirectory = path.resolve(path.dirname(shapefilePath));
  const expectedDirectory = path.resolve(path.join(__dirname, "ShapefileSaveAsData"));
  if (resolvedDirectory !== expectedDirectory) {
    throw new Error(`Refusing to remove files outside the sample output directory: ${resolvedDirectory}`);
  }
  SIDECAR_EXTENSIONS.forEach((extension) => {
    const candidate = sidecarPath(shapefilePath, extension);
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  });
}

function sidecarReport(shapefilePath) {
  return SIDECAR_EXTENSIONS.map((extension) => {
    const candidate = sidecarPath(shapefilePath, extension);
    if (!fs.existsSync(candidate)) return `${extension}: missing`;
    return `${extension}: ${fs.statSync(candidate).size} bytes`;
  });
}

function tableRow(values, widths) {
  return values.map((value, index) => {
    const text = String(value ?? "").replace(/\s+/g, " ");
    const width = widths[index];
    return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
  }).join(" | ").trimEnd();
}

function attributeRows(layerIndex, maximumRows) {
  const definitions = viewer.layerAttributeDefinitions(layerIndex);
  const fields = definitions.map((definition) => String(definition.name ?? ""));
  const rows = [];
  for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
    const attributes = viewer.layerFeatureAttributes(layerIndex, rowIndex);
    if (!attributes || Object.keys(attributes).length === 0) break;
    rows.push(attributes);
  }
  if (rows.length === 0) return ["No attribute rows returned."];

  const widths = [4, ...fields.map((field) => Math.max(12, Math.min(24, field.length + 2)))];
  return [
    tableRow(["#", ...fields], widths),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map((attributes, rowIndex) => tableRow([
      rowIndex,
      ...fields.map((field) => attributes[field] ?? ""),
    ], widths)),
  ];
}

function detailsText(destination, savedLayerIndex = null) {
  const sourceDefinitions = sourceLayerIndex >= 0
    ? viewer.layerAttributeDefinitions(sourceLayerIndex)
    : [];
  const lines = [
    "ShapefileSaveAs sample",
    "",
    "API",
    "addLayer(sourcePath)",
    "saveLayerAsShapefile(index, outputPath)",
    "",
    "Source shapefile",
    sourcePath || "-",
    `Source fields: ${sourceDefinitions.length}`,
    `Source feature count: ${sourceLayerIndex >= 0 ? viewer.layerFeatureCount(sourceLayerIndex) : 0}`,
    "",
    "Output shapefile",
    destination,
    ...sidecarReport(destination),
  ];

  if (savedLayerIndex !== null) {
    const savedInfo = viewer.layerInfo(savedLayerIndex);
    lines.push(
      "",
      "Reloaded output",
      `Layer name: ${savedInfo.name ?? path.parse(destination).name}`,
      `Shape type: ${savedInfo.shapeType ?? "Unknown"}`,
      `Fields: ${viewer.layerAttributeDefinitions(savedLayerIndex).length}`,
      `Feature count: ${viewer.layerFeatureCount(savedLayerIndex)}`,
      `Extent: ${JSON.stringify(savedInfo.extent ?? {})}`,
      "",
      "Reloaded output attributes",
      ...attributeRows(savedLayerIndex, 12),
    );
  } else if (sourceLayerIndex >= 0) {
    lines.push("", "Source attributes", ...attributeRows(sourceLayerIndex, 12));
  }
  return lines.join("\n");
}

function findSavedLayerIndex() {
  const layers = viewer.layersInfo();
  const match = layers.find((layer) => String(layer.name ?? "").toLowerCase().includes("world_4326_copy"));
  if (match && Number.isInteger(match.index)) return match.index;
  return Math.max(0, viewer.layerCount() - 1);
}

function runSaveAs() {
  if (!viewer || sourceLayerIndex < 0 || saving) return;
  saving = true;
  const destination = outputPath();
  viewer.setStatusText("Saving shapefile copy...");

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    removeExistingOutput(destination);
    const saved = viewer.saveLayerAsShapefile(sourceLayerIndex, destination);
    if (!saved) {
      throw new Error("saveLayerAsShapefile returned false.");
    }

    viewer.addLayer(destination);
    const savedLayerIndex = findSavedLayerIndex();
    viewer.clearLog();
    viewer.appendLog(detailsText(destination, savedLayerIndex));
    viewer.removeLayer(savedLayerIndex);
    sourceLayerIndex = 0;
    viewer.setStatusText(`SaveAs wrote ${destination}`);
  } catch (error) {
    viewer.clearLog();
    viewer.appendLog(`${detailsText(destination)}\n\nSaveAs failed\n${error.message}`);
    viewer.setStatusText("SaveAs failed.");
    console.error(error?.stack || error);
  } finally {
    saving = false;
  }
}

function onCommand(commandId) {
  setImmediate(() => {
    if (!viewer) return;
    if (commandId === COMMAND.SAVE_AS) runSaveAs();
    else if (commandId === COMMAND.FULL_EXTENT && sourceLayerIndex >= 0) viewer.zoomToLayer(sourceLayerIndex);
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
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "ShapefileSaveAs",
    width: 1200,
    height: 760,
    navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: COMMAND.SAVE_AS, text: "Save As Shapefile" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
  ], onCommand);
  viewer.addLogPanel("SaveAs state and reloaded output attributes");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing world shapefile...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  sourcePath = await ensureSampleFile(
    WORLD_LAYER_URL,
    "world_4326.zip",
    "world_4326",
    "world_4326.shp",
  );
  if (!viewer) return;

  viewer.addLayer(sourcePath);
  sourceLayerIndex = 0;
  viewer.setLayerName(sourceLayerIndex, "World countries");
  viewer.setLayerStyle(sourceLayerIndex, WORLD_STYLE);
  viewer.zoomToLayer(sourceLayerIndex);
  viewer.clearLog();
  viewer.appendLog(detailsText(outputPath()));
  runSaveAs();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  sourcePath = "";
  sourceLayerIndex = -1;
  saving = false;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
