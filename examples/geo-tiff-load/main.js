"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_8km_tif.zip";

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

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

function extentText(value) {
  if (!value || typeof value !== "object") return "unknown";
  const xMin = Number(value.xMin ?? 0).toFixed(2);
  const yMin = Number(value.yMin ?? 0).toFixed(2);
  const xMax = Number(value.xMax ?? 0).toFixed(2);
  const yMax = Number(value.yMax ?? 0).toFixed(2);
  return `(${xMin}, ${yMin}) - (${xMax}, ${yMax})`;
}

function metadataText(tiffPath, layerIndex) {
  const info = viewer.layerInfo(layerIndex) || {};
  const coordinateSystem = info.coordinateSystem || {};
  const layerExtent = info.projectedExtent || info.extent || {};
  const fileSize = fs.existsSync(tiffPath) ? fs.statSync(tiffPath).size : 0;
  const epsgCode = coordinateSystem.epsgCode || "unknown";

  return [
    "GeoTIFF load sample",
    "",
    "File",
    `Path: ${tiffPath}`,
    `Exists: ${fs.existsSync(tiffPath) ? "yes" : "no"}`,
    `Size: ${fileSize} bytes`,
    "",
    "Raster layer",
    `Name: ${info.name || path.parse(tiffPath).name}`,
    `EPSG: ${epsgCode}`,
    `Coordinate system: ${coordinateSystem.name || "unknown"}`,
    `Layer extent: ${extentText(layerExtent)}`,
    "",
    "SDK flow",
    "viewer.addLayer(path)",
    "viewer.layerInfo(index)",
    "viewer.zoomToLayer(index)",
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
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
}

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "GeoTiffLoad",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addLogPanel("GeoTIFF metadata");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing GeoTIFF sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const tiffPath = await ensureSampleFile(
    SAMPLE_URL,
    "world_8km_tif.zip",
    "world_8km_tif",
    "world_8km.tif",
  );
  if (!viewer || closing) return;

  viewer.addLayer(tiffPath);
  const layerIndex = viewer.layerCount() - 1;
  if (layerIndex < 0) {
    throw new Error(`GeoTIFF could not be loaded: ${tiffPath}`);
  }

  viewer.clearLog();
  viewer.appendLog(metadataText(tiffPath, layerIndex));
  viewer.zoomToLayer(layerIndex);
  viewer.setStatusText(`GeoTIFF loaded: ${path.basename(tiffPath)}`);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (viewer) {
    try {
      viewer.close();
    } catch {
      // The native window may already have been destroyed.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
