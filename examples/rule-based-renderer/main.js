"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/usa_cities.zip";
const DEFAULT_CITY_STYLE = Object.freeze({
  pointColor: "#917B8794",
  lineColor: "#D24B5563",
  pointSize: 4,
  lineWidth: 0.9,
});
const RULE_DEFINITIONS = Object.freeze([
  ["Less than 50,000", "#917B8794", "#D24B5563", 4],
  ["50,000 to 100,000", "#914FA3C4", "#D21D6D83", 5.5],
  ["100,000 to 250,000", "#9155B889", "#D22E7D59", 7.5],
  ["250,000 to 500,000", "#91F2B84B", "#D29B6B18", 10],
  ["500,000 to 1,000,000", "#91E56B5D", "#D29A3E32", 14],
  ["1,000,000 to 5,000,000", "#91A9423A", "#D261201C", 19],
]);

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

function webMercatorPoint(longitude, latitude) {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return [
    longitude * 20037508.342789244 / 180,
    Math.log(Math.tan((90 + clampedLatitude) * Math.PI / 360)) * 20037508.342789244 / Math.PI,
  ];
}

function projectedLayerExtent(shpPath) {
  const header = fs.readFileSync(shpPath).subarray(0, 100);
  if (header.length < 100) throw new Error("Cities shapefile header could not be read.");
  const minimum = webMercatorPoint(header.readDoubleLE(36), header.readDoubleLE(44));
  const maximum = webMercatorPoint(header.readDoubleLE(52), header.readDoubleLE(60));
  const paddingX = Math.max(500000, (maximum[0] - minimum[0]) * 0.12);
  const paddingY = Math.max(500000, (maximum[1] - minimum[1]) * 0.12);
  return extent(
    minimum[0] - paddingX,
    minimum[1] - paddingY,
    maximum[0] + paddingX,
    maximum[1] + paddingY,
  );
}

function createRenderer() {
  return {
    type: "ruleBased",
    defaultStyle: DEFAULT_CITY_STYLE,
    rules: RULE_DEFINITIONS.map(([label, pointColor, lineColor, pointSize]) => ({
      field: "POP_CLASS",
      operator: "equals",
      value: label,
      label,
      enabled: true,
      style: {
        pointColor,
        lineColor,
        pointSize,
        lineWidth: Math.max(0.8, Math.min(1.5, pointSize * 0.06)),
      },
    })),
  };
}

function updateLegend() {
  const renderer = viewer.layerSymbolRenderer(0);
  const rules = Array.isArray(renderer.rules) ? renderer.rules : [];
  viewer.setLegendItems(rules.map((rule) => ({ ...rule, shape: "point" })));
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
  viewer = new ViewerWindow({ title: "RuleBasedRenderer", width: 1200, height: 800, navigationToolbar: false });
  viewer.addLegendPanel("POP_CLASS rules");
  viewer.setTool(ViewerTool.PAN);
  viewer.setLegendItems([{ label: "Preparing USA cities sample data...", enabled: true, shape: "point", style: DEFAULT_CITY_STYLE }]);
  viewer.setStatusText("Preparing USA cities sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  try {
    const citiesPath = await ensureSampleFile(
      SAMPLE_URL, "usa_cities.zip", "usa_cities", "usa_cities.shp",
    );
    if (!viewer) return;
    viewer.addOpenStreetMapLayer();
    viewer.addLayer(citiesPath, {
      buildFeatureSource: true,
      applyDefaultStyle: true,
      defaultStyle: DEFAULT_CITY_STYLE,
    });
    viewer.setLayerName(0, "Cities - rule based by POP_CLASS");
    viewer.setLayerStyle(0, DEFAULT_CITY_STYLE);
    if (!viewer.setLayerSymbolRenderer(0, createRenderer())) {
      throw new Error("Rule based renderer could not be applied.");
    }
    viewer.invalidateRenderCache(true, true);
    viewer.refreshLayers();
    updateLegend();
    viewer.processEvents();
    viewer.setViewExtent(projectedLayerExtent(citiesPath));
    viewer.processEvents();
    viewer.setStatusText("Rule based renderer applied: POP_CLASS");
  } catch (error) {
    viewer?.setLegendItems([{ label: "Rule based renderer could not be created.", enabled: true, shape: "point", style: DEFAULT_CITY_STYLE }]);
    viewer?.setStatusText("Rule based renderer could not be created.");
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
