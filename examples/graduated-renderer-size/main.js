"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const {
  ClassificationMethod,
  ColorRampMode,
  SymbolStyleTarget,
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/usa_cities.zip";
const SIZE_FIELD = "POP_CLASS_SIZE";
const MINIMUM_POINT_SIZE = 3;
const MAXIMUM_POINT_SIZE = 36;
const CLASS_LABELS = Object.freeze([
  "Less than 50,000",
  "50,000 to 100,000",
  "100,000 to 250,000",
  "250,000 to 500,000",
  "500,000 to 1,000,000",
  "1,000,000 to 5,000,000",
]);
const CITY_STYLE = Object.freeze({
  pointColor: "#48D95F35",
  pointSize: MINIMUM_POINT_SIZE,
  lineColor: "#AF8A3A24",
  lineWidth: 0.9,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

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

function populationClassSize(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const index = CLASS_LABELS.findIndex((label) => label.toLowerCase() === normalized);
  return index < 0 ? 0 : index + 1;
}

function readDbfRecords(dbfPath) {
  const data = fs.readFileSync(dbfPath);
  const recordCount = data.readUInt32LE(4);
  const headerLength = data.readUInt16LE(8);
  const recordLength = data.readUInt16LE(10);
  const fields = [];
  for (let offset = 32; offset < headerLength - 1; offset += 32) {
    if (data[offset] === 0x0d) break;
    const zero = data.indexOf(0, offset);
    const end = zero >= offset && zero < offset + 11 ? zero : offset + 11;
    fields.push({
      name: data.toString("ascii", offset, end),
      type: String.fromCharCode(data[offset + 11]),
      length: data[offset + 16],
      decimals: data[offset + 17],
    });
  }
  const records = [];
  for (let row = 0; row < recordCount; row += 1) {
    const start = headerLength + row * recordLength;
    if (start + recordLength > data.length || data[start] === 0x2a) {
      records.push({});
      continue;
    }
    const attributes = {};
    let fieldOffset = start + 1;
    for (const field of fields) {
      const text = data.toString("latin1", fieldOffset, fieldOffset + field.length).trim();
      fieldOffset += field.length;
      attributes[field.name] = (field.type === "N" || field.type === "F") && text
        ? Number(text)
        : text;
    }
    records.push(attributes);
  }
  return records;
}

function readPointRecords(shpPath) {
  const data = fs.readFileSync(shpPath);
  const points = [];
  let offset = 100;
  while (offset + 8 <= data.length) {
    const contentLength = data.readUInt32BE(offset + 4) * 2;
    offset += 8;
    if (offset + contentLength > data.length) break;
    const shapeType = data.readUInt32LE(offset);
    if (shapeType === 1) points.push([data.readDoubleLE(offset + 4), data.readDoubleLE(offset + 12)]);
    else points.push(null);
    offset += contentLength;
  }
  return points;
}

function webMercatorPoint([longitude, latitude]) {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const x = longitude * 20037508.342789244 / 180;
  const y = Math.log(Math.tan((90 + clampedLatitude) * Math.PI / 360)) * 20037508.342789244 / Math.PI;
  return [x, y];
}

function cityViewExtent(points) {
  const projected = points.map(webMercatorPoint);
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const xMin = Math.min(...xs);
  const yMin = Math.min(...ys);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const paddingX = Math.max(500000, (xMax - xMin) * 0.12);
  const paddingY = Math.max(500000, (yMax - yMin) * 0.12);
  return extent(xMin - paddingX, yMin - paddingY, xMax + paddingX, yMax + paddingY);
}

function updateLegend(renderer) {
  const ranges = Array.isArray(renderer.ranges) ? renderer.ranges : [];
  viewer.setLegendItems(ranges.map((range, index) => ({
    ...range,
    shape: "point",
    label: CLASS_LABELS[index] ?? range.label,
  })));
}

function applyRenderer() {
  const applied = viewer.applyGraduatedRenderer(0, {
    fieldName: SIZE_FIELD,
    method: ClassificationMethod.EQUAL_INTERVAL,
    classCount: 6,
    colorRampName: "Plasma",
    colorRampMode: ColorRampMode.DISCRETE,
    styleTarget: SymbolStyleTarget.SIZE_OR_WIDTH,
    startSize: MINIMUM_POINT_SIZE,
    endSize: MAXIMUM_POINT_SIZE,
  });
  if (!applied) throw new Error("Could not create graduated size renderer from POP_CLASS.");

  const renderer = viewer.layerSymbolRenderer(0);
  for (const range of renderer.ranges ?? []) {
    const style = range.style ?? {};
    const pointSize = Number(style.pointSize ?? MINIMUM_POINT_SIZE);
    style.pointColor = "#48D95F35";
    style.lineColor = "#AF8A3A24";
    style.lineWidth = Math.min(2.2, Math.max(0.9, pointSize * 0.07));
  }
  renderer.defaultStyle = CITY_STYLE;
  if (!viewer.setLayerSymbolRenderer(0, renderer)) {
    throw new Error("Graduated size renderer styles could not be updated.");
  }
  viewer.invalidateRenderCache(true, true);
  viewer.refreshLayers();
  updateLegend(renderer);
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
  viewer = new ViewerWindow({ title: "GraduatedRendererSize", width: 1200, height: 800, navigationToolbar: false });
  viewer.addLegendPanel("POP_CLASS size classes");
  viewer.setTool(ViewerTool.PAN);
  viewer.setLegendItems([{ label: "Preparing USA cities sample data...", enabled: true, shape: "point", style: CITY_STYLE }]);
  viewer.setStatusText("Preparing USA cities sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const citiesPath = await ensureSampleFile(
      SAMPLE_URL, "usa_cities.zip", "usa_cities", "usa_cities.shp",
    );
    if (!viewer) return;
    const sourcePoints = readPointRecords(citiesPath);
    const sourceAttributes = readDbfRecords(path.join(path.dirname(citiesPath), "usa_cities.dbf"));
    const points = [];
    const attributes = [];
    for (let index = 0; index < Math.min(sourcePoints.length, sourceAttributes.length); index += 1) {
      if (!sourcePoints[index] || !Object.keys(sourceAttributes[index]).length) continue;
      points.push(sourcePoints[index]);
      attributes.push({
        ...sourceAttributes[index],
        [SIZE_FIELD]: populationClassSize(sourceAttributes[index].POP_CLASS),
      });
    }
    if (!points.length) throw new Error("No city points could be loaded.");

    viewer.addOpenStreetMapLayer();
    const layerIndex = viewer.addAttributedPointLayer(
      "Cities - graduated size by POP_CLASS", points, attributes, CITY_STYLE, 4326,
    );
    if (layerIndex < 0) throw new Error("Cities memory layer could not be created.");
    applyRenderer();
    viewer.processEvents();
    viewer.setViewExtent(cityViewExtent(points));
    viewer.processEvents();
    viewer.setStatusText("Graduated size renderer applied: POP_CLASS");
  } catch (error) {
    viewer?.setLegendItems([{ label: "Graduated size renderer could not be created.", enabled: true, shape: "point", style: CITY_STYLE }]);
    viewer?.setStatusText("Graduated size renderer could not be created.");
    throw error;
  }
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
