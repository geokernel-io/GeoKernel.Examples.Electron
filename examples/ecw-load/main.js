"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

const SAMPLE_URL =
  "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_8km_ecw.zip";

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

function verifyRuntime() {
  const binDir = findBinDir();
  const platformCandidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll")
      : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);

  if (!platformCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }

  const ecwRuntime = path.join(binDir, "NCSEcw.dll");
  const ecwPlugin = path.join(binDir, "gdalplugins", "gdal_ECW_JP2ECW.dll");
  if (!fs.existsSync(ecwRuntime) || !fs.existsSync(ecwPlugin)) {
    throw new Error(
      `GeoKernel Electron runtime is missing the GDAL ECW driver or NCSEcw.dll: ${binDir}`,
    );
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

function metadataText(ecwPath, layerIndex) {
  const info = viewer.layerInfo(layerIndex) || {};
  const coordinateSystem = info.coordinateSystem || {};
  const layerExtent = info.projectedExtent || info.extent || {};
  const fileSize = fs.existsSync(ecwPath) ? fs.statSync(ecwPath).size : 0;

  return [
    "ECW load sample",
    "",
    "File",
    `Path: ${ecwPath}`,
    `Exists: ${fs.existsSync(ecwPath) ? "yes" : "no"}`,
    `Size: ${fileSize} bytes`,
    "",
    "Raster layer",
    `Name: ${info.name || path.parse(ecwPath).name}`,
    `EPSG: ${coordinateSystem.epsgCode || "unknown"}`,
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
  verifyRuntime();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "EcwLoad",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addLogPanel("ECW metadata");
  viewer.setTool(ViewerTool.PAN);
  viewer.setStatusText("Preparing ECW sample data...");
  viewer.show();
  viewer.processEvents();
  startEventPump();

  const ecwPath = await ensureSampleFile(
    SAMPLE_URL,
    "world_8km_ecw.zip",
    "world_8km_ecw",
    "world_8km.ecw",
  );
  if (!viewer || closing) return;

  viewer.addLayer(ecwPath);
  const layerIndex = viewer.layerCount() - 1;
  if (layerIndex < 0) {
    throw new Error(`ECW could not be loaded: ${ecwPath}`);
  }

  viewer.clearLog();
  viewer.appendLog(metadataText(ecwPath, layerIndex));
  viewer.zoomToLayer(layerIndex);
  viewer.setStatusText(`ECW loaded: ${path.basename(ecwPath)}`);
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
