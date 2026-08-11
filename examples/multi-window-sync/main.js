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

const SAMPLE_URL = "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/world_4326.zip";
const INITIAL_EXTENT = extent(-151.2, 16.4, -41.6, 55.6);
const WORLD_STYLE = {
  fillColor: "#D8E5E1",
  fillOpacity: 220,
  lineColor: "#6F8883",
  lineWidth: 0.8,
};

const COMMAND = Object.freeze({
  SYNC: 1,
  ZOOM_IN: 2,
  ZOOM_OUT: 3,
  FULL_EXTENT: 4,
  ZOOM_BOX: 5,
  PAN: 6,
});

let windowViewer = null;
let leftViewer = null;
let rightViewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let syncEnabled = true;
let synchronizing = false;

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

function copyExtent(source, target, direction) {
  if (!syncEnabled || synchronizing || !source || !target) return;
  const sourceExtent = source.getViewExtent();
  if (!sourceExtent) return;
  synchronizing = true;
  try {
    target.setViewExtent(sourceExtent);
    windowViewer.setStatusText(direction);
  } finally {
    synchronizing = false;
  }
}

function onLeftEvent(event) {
  if (event.eventType === ViewerEventType.VISIBLE_EXTENT_CHANGED) {
    copyExtent(leftViewer, rightViewer, "Viewer A -> Viewer B");
  }
}

function onRightEvent(event) {
  if (event.eventType === ViewerEventType.VISIBLE_EXTENT_CHANGED) {
    copyExtent(rightViewer, leftViewer, "Viewer B -> Viewer A");
  }
}

function setTool(tool) {
  leftViewer.setTool(tool);
  rightViewer.setTool(tool);
}

function handleCommand(commandId) {
  if (commandId === COMMAND.SYNC) {
    syncEnabled = !syncEnabled;
    windowViewer.setStatusText(syncEnabled ? "Sync enabled. Drive either viewer." : "Sync disabled.");
    if (syncEnabled) copyExtent(leftViewer, rightViewer, "Viewer A -> Viewer B");
  } else if (commandId === COMMAND.ZOOM_IN) {
    leftViewer.zoomIn();
  } else if (commandId === COMMAND.ZOOM_OUT) {
    leftViewer.zoomOut();
  } else if (commandId === COMMAND.FULL_EXTENT) {
    leftViewer.fullExtent();
  } else if (commandId === COMMAND.ZOOM_BOX) {
    setTool(ViewerTool.ZOOM_BOX);
  } else if (commandId === COMMAND.PAN) {
    setTool(ViewerTool.PAN);
  }
}

function loadWorld(viewer, filePath, name) {
  viewer.addLayer(filePath);
  viewer.setLayerName(0, name);
  viewer.setLayerStyle(0, WORLD_STYLE);
  viewer.refreshLayers();
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!windowViewer) return;
    windowViewer.processEvents();
    if (windowViewer.isVisible()) {
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
  windowViewer = new ViewerWindow({
    title: "MultiWindowSync",
    width: 1280,
    height: 760,
    navigationToolbar: false,
    viewerPanes: ["Viewer A", "Viewer B"],
  });
  leftViewer = windowViewer.pane(0);
  rightViewer = windowViewer.pane(1);
  windowViewer.addCommandToolbar([
    { id: COMMAND.SYNC, text: "Sync On/Off" },
    { id: COMMAND.ZOOM_IN, text: "Zoom In", separatorBefore: true },
    { id: COMMAND.ZOOM_OUT, text: "Zoom Out" },
    { id: COMMAND.FULL_EXTENT, text: "Full Extent" },
    { id: COMMAND.ZOOM_BOX, text: "Zoom Box", separatorBefore: true },
    { id: COMMAND.PAN, text: "Pan" },
  ], handleCommand);
  setTool(ViewerTool.PAN);
  leftViewer.setEventCallback(onLeftEvent);
  rightViewer.setEventCallback(onRightEvent);
  windowViewer.setStatusText("Preparing world data...");
  windowViewer.show();
  windowViewer.processEvents();
  startEventPump();

  const worldPath = await ensureSampleFile(SAMPLE_URL, "world_4326.zip", "world_4326", "world_4326.shp");
  if (!windowViewer) return;
  loadWorld(leftViewer, worldPath, "World A");
  loadWorld(rightViewer, worldPath, "World B");
  synchronizing = true;
  try {
    leftViewer.setViewExtent(INITIAL_EXTENT);
    rightViewer.setViewExtent(INITIAL_EXTENT);
  } finally {
    synchronizing = false;
  }
  windowViewer.setStatusText("Sync enabled. Drive either viewer.");
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  if (windowViewer) windowViewer.close();
  windowViewer = null;
  leftViewer = null;
  rightViewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
