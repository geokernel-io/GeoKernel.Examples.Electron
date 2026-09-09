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
const { ensureSampleFile } = require("../common/sample-data");

const WORLD_LAYER_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const WEB_MERCATOR_LIMIT = 20037508.342789244;
const CONTROL = Object.freeze({ SPATIAL_REFERENCE: 1, FULL_EXTENT: 2 });
const WORLD_STYLE = Object.freeze({
  fillColor: "#D8E5E1",
  fillOpacity: 210,
  lineColor: "#6F8883",
  lineWidth: 0.75,
});
const SPATIAL_REFERENCES = Object.freeze([
  {
    label: "EPSG:4326 - WGS 84",
    shortName: "EPSG:4326",
    preset: "EPSG:4326",
    extent: extent(-180, -85, 180, 85),
    decimals: 6,
  },
  {
    label: "EPSG:3857 - WGS 84 / Web Mercator",
    shortName: "EPSG:3857",
    preset: "EPSG:3857",
    extent: extent(-WEB_MERCATOR_LIMIT, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT),
    decimals: 2,
  },
  {
    label: "EPSG:3395 - WGS 84 / World Mercator",
    shortName: "EPSG:3395",
    preset: "EPSG:3395",
    extent: extent(-WEB_MERCATOR_LIMIT, -20000000, WEB_MERCATOR_LIMIT, 20000000),
    decimals: 2,
  },
  {
    label: "World Miller Cylindrical",
    shortName: "Miller",
    preset: "Miller",
    extent: extent(-WEB_MERCATOR_LIMIT, -15500000, WEB_MERCATOR_LIMIT, 15500000),
    decimals: 2,
  },
  {
    label: "World Mollweide",
    shortName: "Mollweide",
    preset: "Mollweide",
    extent: extent(-18500000, -9500000, 18500000, 9500000),
    decimals: 2,
  },
  {
    label: "World Sinusoidal",
    shortName: "Sinusoidal",
    preset: "Sinusoidal",
    extent: extent(-WEB_MERCATOR_LIMIT, -10500000, WEB_MERCATOR_LIMIT, 10500000),
    decimals: 2,
  },
  {
    label: "World Eckert IV",
    shortName: "Eckert IV",
    preset: "Eckert IV",
    extent: extent(-18500000, -9500000, 18500000, 9500000),
    decimals: 2,
  },
  {
    label: "World Eckert VI",
    shortName: "Eckert VI",
    preset: "Eckert VI",
    extent: extent(-18500000, -9500000, 18500000, 9500000),
    decimals: 2,
  },
]);

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let worldLayerLoaded = false;
let selectedIndex = 1;

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

function selectedSpatialReference() {
  return SPATIAL_REFERENCES[selectedIndex] ?? null;
}

function applySelectedSpatialReference() {
  if (!viewer || !worldLayerLoaded) return;
  const option = selectedSpatialReference();
  if (!option) return;

  if (!viewer.setCoordinateSystemPreset(option.preset)) {
    throw new Error(`${option.shortName} could not be applied.`);
  }
  viewer.setViewExtent(option.extent);
  viewer.refreshLayers();
  viewer.setStatusText(`${option.shortName}: world_4326.shp reprojected on the fly.`);
}

function onControlChanged(controlId, _numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      if (controlId === CONTROL.SPATIAL_REFERENCE) {
        const index = SPATIAL_REFERENCES.findIndex((option) => option.label === textValue);
        if (index >= 0) selectedIndex = index;
        applySelectedSpatialReference();
      } else if (controlId === CONTROL.FULL_EXTENT && worldLayerLoaded) {
        const option = selectedSpatialReference();
        if (option) viewer.setViewExtent(option.extent);
      }
    } catch (error) {
      viewer?.setStatusText(error.message);
      console.error(error?.stack || error);
    }
  });
}

function onViewerEvent(event) {
  if (!viewer || event.eventType !== ViewerEventType.MOUSE_COORDINATES_CHANGED) return;
  const option = selectedSpatialReference();
  if (!option) return;

  const screenX = Number(event.screenRectangle?.left);
  const screenY = Number(event.screenRectangle?.top);
  const worldX = Number(event.extent?.xMin);
  const worldY = Number(event.extent?.yMin);
  if (![screenX, screenY, worldX, worldY].every(Number.isFinite)) return;

  viewer.setStatusText(
    `Screen: ${screenX.toFixed(0)}, ${screenY.toFixed(0)}`
    + `    |    ${option.shortName}: ${worldX.toFixed(option.decimals)}, ${worldY.toFixed(option.decimals)}`,
  );
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
    title: "OnTheFlyReproject",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "Spatial reference",
    area: "left",
    width: 350,
    controls: [
      {
        id: CONTROL.SPATIAL_REFERENCE,
        type: "combo",
        label: "Viewer CRS",
        options: SPATIAL_REFERENCES.map((option) => option.label),
        value: SPATIAL_REFERENCES[selectedIndex].label,
      },
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
    ],
  }, onControlChanged);
  viewer.setTool(ViewerTool.PAN);
  viewer.setEventCallback(onViewerEvent);
  viewer.setStatusText("Preparing world sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(
    WORLD_LAYER_URL,
    "world_4326.zip",
    "world_4326",
    "world_4326.shp",
  );
  if (!viewer) return;

  viewer.addLayer(worldPath);
  viewer.setLayerName(0, "World countries - source EPSG:4326");
  if (!viewer.setLayerCoordinateSystemPreset(0, "EPSG:4326")) {
    throw new Error("Source layer CRS could not be set to EPSG:4326.");
  }
  viewer.setLayerStyle(0, WORLD_STYLE);
  worldLayerLoaded = true;
  applySelectedSpatialReference();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  worldLayerLoaded = false;
  selectedIndex = 1;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
