"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const LEFT = [[-6.0, -2.2], [-4.2, 1.6], [-2.0, -0.5], [0.2, 2.1], [2.4, -0.7], [5.8, 2.2]];
const RIGHT = [[-6.2, 1.9], [-3.8, -1.6], [-1.4, 1.5], [1.2, -1.9], [3.2, 1.3], [5.8, -1.2]];
const FULL_EXTENT = extent(-7.0, -3.2, 6.8, 3.2);
const LEFT_STYLE = { fillOpacity: 0, lineColor: "#2F80C2", lineWidth: 3, pointColor: "#2F80C2", pointSize: 7 };
const RIGHT_STYLE = { fillOpacity: 0, lineColor: "#D95D39", lineWidth: 3, pointColor: "#D95D39", pointSize: 7 };
const CROSSING_STYLE = { pointColor: "#C1121F", pointSize: 12, lineColor: "#7A0010", lineWidth: 1 };

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
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function extentText(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return `(${Math.min(...xs).toFixed(2)}, ${Math.min(...ys).toFixed(2)}) - (${Math.max(...xs).toFixed(2)}, ${Math.max(...ys).toFixed(2)})`;
}

function normalizePoint(value) {
  return [Number(value.x ?? value[0]), Number(value.y ?? value[1])];
}

function renderScene(showResult) {
  const currentExtent = showResult ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  if (!viewer.addPolylineShape(LEFT, LEFT_STYLE) || !viewer.addPolylineShape(RIGHT, RIGHT_STYLE)) {
    throw new Error("Source polylines could not be rendered.");
  }
  const details = [
    "GetCrossings(left, right)",
    "The two polylines are arranged to cross at multiple segment intersections.", "",
    `Left vertices: ${LEFT.length}`,
    `Right vertices: ${RIGHT.length}`,
    `Left extent: ${extentText(LEFT)}`,
    `Right extent: ${extentText(RIGHT)}`,
  ];

  if (!showResult) {
    details.push("", "Click Run GetCrossings to calculate intersection points.");
    viewer.setStatusText("Source polylines are ready. Click Run GetCrossings.");
  } else {
    const crossings = viewer.polylineCrossings(LEFT, RIGHT).map(normalizePoint);
    details.push("", `Crossing count: ${crossings.length}`);
    crossings.forEach(([x, y], index) => {
      if (!viewer.addPointShape(x, y, CROSSING_STYLE)) {
        throw new Error(`Crossing P${index + 1} could not be rendered.`);
      }
      details.push(`P${index + 1}: (${x.toFixed(3)}, ${y.toFixed(3)})`);
    });
    viewer.setStatusText(`GetCrossings found ${crossings.length} point(s).`);
  }

  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(currentExtent ?? FULL_EXTENT);
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
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

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "GetCrossings", width: 980, height: 680, navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Operation: GetCrossings(left, right)", enabled: false },
    { id: 3, text: "Run GetCrossings" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 3) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`GetCrossings failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("GetCrossings details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  renderScene(false);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (viewer) {
    try { viewer.close(); } catch { /* Native window may already be gone. */ }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
