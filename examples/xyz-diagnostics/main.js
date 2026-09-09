"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const {
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_EXTENT_3857 = extent(-1400000, 4100000, 4200000, 7800000);
const CONTROL = Object.freeze({ REFRESH: 1 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let diagnosticsTimer = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let layerIndex = -1;

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

function cacheDirectory() {
  return path.resolve(__dirname, "..", "..", "outputs", "cache", "xyz-diagnostics", "osm");
}

function averageText(totalMilliseconds, count) {
  return count > 0 ? `${(totalMilliseconds / count).toFixed(2)} ms` : "n/a";
}

function bytesText(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(2)} MiB`;
}

function detailsText(snapshot) {
  const memoryTotal = snapshot.memoryHits + snapshot.memoryMisses;
  const diskTotal = snapshot.diskHits + snapshot.diskMisses;
  const downloadTotal = snapshot.downloadsSucceeded + snapshot.downloadsFailed;
  return [
    "XYZ diagnosticsSnapshot sample",
    `Updated: ${new Date().toLocaleTimeString()}`,
    "",
    "Layer",
    `Name: ${snapshot.name}`,
    `URL template: ${snapshot.urlTemplate}`,
    `Tile size: ${snapshot.tileSize}`,
    `Zoom range: ${snapshot.minZoom} - ${snapshot.maxZoom}`,
    `Local cache: ${snapshot.localCacheEnabled ? "enabled" : "disabled"}`,
    `Cache directory: ${snapshot.cacheDirectory}`,
    "",
    "Memory cache",
    `Hits: ${snapshot.memoryHits}`,
    `Misses: ${snapshot.memoryMisses}`,
    `Total lookups: ${memoryTotal}`,
    "",
    "Disk cache",
    `Hits: ${snapshot.diskHits}`,
    `Misses: ${snapshot.diskMisses}`,
    `Total lookups: ${diskTotal}`,
    `Read time total: ${snapshot.diskReadMs} ms`,
    `Decode time total: ${snapshot.decodeMs} ms`,
    `Average read: ${averageText(snapshot.diskReadMs, snapshot.diskHits)}`,
    "",
    "Network",
    `Requests started: ${snapshot.downloadsStarted}`,
    `Downloads succeeded: ${snapshot.downloadsSucceeded}`,
    `Downloads failed: ${snapshot.downloadsFailed}`,
    `Completed downloads: ${downloadTotal}`,
    `Downloaded bytes: ${bytesText(snapshot.bytesDownloaded)}`,
    `Download time total: ${snapshot.downloadMs} ms`,
    `Average download: ${averageText(snapshot.downloadMs, downloadTotal)}`,
    "",
    "How to test",
    "- Pan or zoom the map to request new tiles.",
    "- First pass usually increases downloads and disk misses.",
    "- Revisit the same area to see memory/disk cache hits.",
  ].join("\n");
}

function refreshDiagnostics() {
  if (!viewer || layerIndex < 0 || closing) return;
  try {
    const snapshot = viewer.xyzLayerDiagnostics(layerIndex);
    if (!snapshot || typeof snapshot !== "object") {
      viewer.clearLog();
      viewer.appendLog("XYZ layer diagnostics are not available.");
      return;
    }
    viewer.clearLog();
    viewer.appendLog(detailsText(snapshot));
    viewer.setStatusText(
      `XYZ diagnostics: ${snapshot.downloadsStarted} requests, ` +
      `${snapshot.downloadsSucceeded} downloads, ${snapshot.diskHits} disk hits, ` +
      `${snapshot.memoryHits} memory hits`,
    );
  } catch (error) {
    viewer.clearLog();
    viewer.appendLog(`Diagnostics could not be read:\n${error.message}`);
  }
}

function onControlChanged(controlId) {
  if (controlId === CONTROL.REFRESH) refreshDiagnostics();
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

function start() {
  closing = false;
  layerIndex = -1;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "XyzDiagnostics",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "XYZ diagnostics commands",
    area: "top",
    controls: [{ id: CONTROL.REFRESH, type: "button", text: "Refresh Stats" }],
  }, onControlChanged);
  viewer.addLogPanel("XYZ diagnostics");
  viewer.setTool(ViewerTool.PAN);

  const directory = cacheDirectory();
  fs.mkdirSync(directory, { recursive: true });
  layerIndex = viewer.addXyzLayer({
    name: "OSM Diagnostics",
    urlTemplate: OSM_URL,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    attribution: "OpenStreetMap",
    localCacheEnabled: true,
    cacheDirectory: directory,
  });
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error("XYZ diagnostics layer could not be created.");
  }

  viewer.show();
  viewer.processEvents();
  viewer.setViewExtent(DEFAULT_EXTENT_3857);
  refreshDiagnostics();
  diagnosticsTimer = setInterval(refreshDiagnostics, 750);
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
  diagnosticsTimer = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  layerIndex = -1;
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
