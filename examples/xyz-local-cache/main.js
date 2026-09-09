"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const {
  ViewerTool,
  ViewerWindow,
  extent,
  findBinDir,
} = require("geokernel-electron");

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_EXTENT_3857 = extent(-1400000, 4100000, 4200000, 7800000);
const CONTROL = Object.freeze({
  CACHE: 1,
  DIRECTORY: 2,
  BROWSE: 3,
  APPLY: 4,
  REFRESH: 5,
  CLEAR: 6,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let applyTimer = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let cacheEnabled = true;
let cacheDirectory = defaultCacheDirectory();

function defaultCacheDirectory() {
  return path.resolve(__dirname, "..", "..", "outputs", "cache", "xyz-local-cache", "osm");
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

function normalizedCacheDirectory() {
  const value = cacheDirectory.trim();
  return path.resolve(value || defaultCacheDirectory());
}

function cacheStatistics(directory) {
  let tileFiles = 0;
  let bytes = 0;
  if (!fs.existsSync(directory)) return { tileFiles, bytes };

  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tile")) {
        tileFiles += 1;
        bytes += fs.statSync(entryPath).size;
      }
    }
  }
  return { tileFiles, bytes };
}

function formatBytes(bytes) {
  const kilobytes = bytes / 1024;
  const megabytes = kilobytes / 1024;
  if (megabytes >= 1) return `${megabytes.toFixed(2)} MB`;
  if (kilobytes >= 1) return `${kilobytes.toFixed(1)} KB`;
  return `${bytes} bytes`;
}

function updateDetails() {
  if (!viewer) return;
  const directory = normalizedCacheDirectory();
  const stats = cacheStatistics(directory);
  viewer.clearLog();
  viewer.appendLog([
    "XYZ local cache sample",
    "",
    "URL template:",
    OSM_URL,
    "",
    `Local cache: ${cacheEnabled ? "enabled" : "disabled"}`,
    "Configured cache directory:",
    directory,
    "",
    "Cache contents:",
    `Tile files: ${stats.tileFiles}`,
    `Size: ${formatBytes(stats.bytes)}`,
    "",
    "SDK flow:",
    "viewer.addXyzLayer({ name, urlTemplate, minZoom, maxZoom, tileSize,",
    "  attribution, localCacheEnabled, cacheDirectory })",
    "",
    "Pan or zoom the map to request tiles. Cached tiles are reused on later runs.",
  ].join("\n"));
}

function applyCache() {
  if (!viewer || closing) return;
  cacheDirectory = normalizedCacheDirectory();
  viewer.setControlValue(CONTROL.DIRECTORY, cacheDirectory);
  if (cacheEnabled) fs.mkdirSync(cacheDirectory, { recursive: true });

  viewer.clearLayers();
  const layerIndex = viewer.addXyzLayer({
    name: "OSM with Local Cache",
    urlTemplate: OSM_URL,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    attribution: "© OpenStreetMap contributors",
    localCacheEnabled: cacheEnabled,
    cacheDirectory: cacheEnabled ? cacheDirectory : "",
  });
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error("XYZ local-cache layer could not be created.");
  }
  viewer.setViewExtent(DEFAULT_EXTENT_3857);
  updateDetails();
  viewer.setStatusText(cacheEnabled
    ? "XYZ layer loaded with local disk cache."
    : "XYZ layer loaded with local cache disabled.");
}

function scheduleApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    try {
      applyCache();
    } catch (error) {
      if (!viewer) return;
      viewer.setStatusText(`XYZ local cache failed: ${error.message}`);
    }
  }, 50);
}

async function browseCacheDirectory() {
  const result = await dialog.showOpenDialog({
    title: "Select XYZ cache directory",
    defaultPath: normalizedCacheDirectory(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0 || !viewer) return;
  cacheDirectory = result.filePaths[0];
  viewer.setControlValue(CONTROL.DIRECTORY, cacheDirectory);
}

function tileFilesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tile")) files.push(entryPath);
    }
  }
  return files;
}

async function clearCache() {
  const directory = normalizedCacheDirectory();
  const answer = await dialog.showMessageBox({
    type: "question",
    title: "XyzLocalCache",
    message: "Clear all cached tiles?",
    detail: directory,
    buttons: ["Clear Cache", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0 || !viewer) return;

  let removed = 0;
  for (const tileFile of tileFilesUnder(directory)) {
    try {
      fs.unlinkSync(tileFile);
      removed += 1;
    } catch {
      // A tile still being written is left intact and counted on refresh.
    }
  }
  updateDetails();
  viewer.setStatusText(`Cache cleared: ${removed} tile file(s) removed.`);
}

function onControlChanged(controlId, _numericValue, textValue) {
  if (controlId === CONTROL.CACHE) {
    cacheEnabled = (textValue || "Enabled") === "Enabled";
    scheduleApply();
  } else if (controlId === CONTROL.DIRECTORY) {
    cacheDirectory = textValue || defaultCacheDirectory();
  } else if (controlId === CONTROL.BROWSE) {
    void browseCacheDirectory();
  } else if (controlId === CONTROL.APPLY) {
    scheduleApply();
  } else if (controlId === CONTROL.REFRESH) {
    updateDetails();
    viewer?.setStatusText("Cache statistics refreshed.");
  } else if (controlId === CONTROL.CLEAR) {
    void clearCache();
  }
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
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
  if (viewer) {
    try {
      viewer.clearLayers();
      viewer.processEvents();
      viewer.close();
    } catch {
      // The native window may already have been destroyed.
    }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
  app.exit(0);
}

function start() {
  closing = false;
  cacheEnabled = true;
  cacheDirectory = defaultCacheDirectory();
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "XyzLocalCache",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });
  viewer.addControlPanel({
    title: "XYZ local cache",
    area: "left",
    width: 500,
    controls: [
      { id: CONTROL.CACHE, type: "combo", label: "Local cache", options: ["Enabled", "Disabled"], value: "Enabled" },
      { id: CONTROL.DIRECTORY, type: "text", label: "Cache", value: cacheDirectory, minimumWidth: 390 },
      { id: CONTROL.BROWSE, type: "button", text: "Browse" },
      { id: CONTROL.APPLY, type: "button", text: "Apply Cache" },
      { id: CONTROL.REFRESH, type: "button", text: "Refresh Stats" },
      { id: CONTROL.CLEAR, type: "button", text: "Clear Cache" },
    ],
  }, onControlChanged);
  if (!viewer.setControlValue(CONTROL.DIRECTORY, cacheDirectory)) {
    throw new Error("This GeoKernel runtime does not support text controls.");
  }
  viewer.addLogPanel("Local cache details");
  viewer.setTool(ViewerTool.PAN);
  applyCache();
  viewer.show();
  viewer.processEvents();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  closing = true;
  if (viewer) {
    try {
      viewer.clearLayers();
      viewer.processEvents();
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
