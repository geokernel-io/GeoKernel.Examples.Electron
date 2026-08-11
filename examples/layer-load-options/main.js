"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [path.join(binDir, "platforms", "qwindows.dll"), path.join(binDir, "plugins", "platforms", "qwindows.dll")];
  if (!candidates.some(fs.existsSync)) throw new Error(`GeoKernel Electron runtime is missing qwindows.dll: ${binDir}`);
}

function startEventPump() {
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { viewerWasVisible = true; viewerHiddenSince = 0; return; }
    if (viewerWasVisible && viewerHiddenSince === 0) viewerHiddenSince = Date.now();
    if (viewerWasVisible && Date.now() - viewerHiddenSince > 750) app.quit();
  }, 16);
}

async function start() {
  verifyQtPlatformPlugin();
  const samplePath = await ensureSampleFile(
    "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/usa_states_3857.zip",
    "usa_states_3857.zip", "usa_states_3857", "usa_states_3857.shp",
  );
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "LayerLoadOptions", width: 1200, height: 800, navigationToolbar: false });
  viewer.addSpatialIndexBenchmarkToolbar({
    filePath: samplePath,
    defaultStyle: { fillColor: "#D8E5E1", fillOpacity: 210, lineColor: "#607D78", lineWidth: 0.9 },
  });
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null; viewerWasVisible = false; viewerHiddenSince = 0;
  if (viewer) viewer.close(); viewer = null;
  if (keeperWindow) keeperWindow.close(); keeperWindow = null;
}

module.exports = { start, stop };
