"use strict";

const fs = require("fs");
const path = require("path");

const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, findBinDir } = require("geokernel-electron");

const { ensureSampleFile } = require("../common/sample-data");

const PROJECT_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/andalucia.zip";

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
    throw new Error(
      [
        "GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll.",
        `Runtime bin: ${binDir}`,
        "Expected one of:",
        ...candidates.map((candidate) => `  - ${candidate}`),
        "Publish a new geokernel-electron package that includes the Qt platforms folder.",
      ].join("\n"),
    );
  }
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!viewer) {
      return;
    }

    viewer.processEvents();
    const visible = viewer.isVisible();
    if (visible) {
      viewerWasVisible = true;
      viewerHiddenSince = 0;
      return;
    }

    if (viewerWasVisible && viewerHiddenSince === 0) {
      viewerHiddenSince = Date.now();
    }

    if (viewerWasVisible && Date.now() - viewerHiddenSince > 750) {
      app.quit();
    }
  }, 16);
}

async function loadProject() {
  const projectPath = await ensureSampleFile(
    PROJECT_URL,
    "andalucia.zip",
    "andalucia",
    "andalucia.geokernel",
  );

  if (!viewer) {
    return;
  }

  if (!viewer.openProject(projectPath)) {
    throw new Error(`Project could not be loaded: ${projectPath}`);
  }
}

async function start() {
  verifyQtPlatformPlugin();

  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
    },
  });

  viewer = new ViewerWindow({
    title: "Project",
    width: 1200,
    height: 800,
    navigationToolbar: true,
  });

  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();

  await loadProject();
}

function stop() {
  if (eventPump) {
    clearInterval(eventPump);
    eventPump = null;
  }
  viewerWasVisible = false;
  viewerHiddenSince = 0;

  if (viewer) {
    viewer.close();
    viewer = null;
  }

  if (keeperWindow) {
    keeperWindow.close();
    keeperWindow = null;
  }
}

module.exports = {
  start,
  stop,
};
