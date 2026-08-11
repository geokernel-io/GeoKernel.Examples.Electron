"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const VALID = [[-5.0, -1.6], [-2.0, -1.6], [-2.0, 1.4], [-5.0, 1.4], [-5.0, -1.6]];
const BOW_TIE = [[0.0, -1.6], [3.3, 1.4], [0.0, 1.4], [3.3, -1.6], [0.0, -1.6]];
const FULL_EXTENT = extent(-5.8, -2.7, 5.9, 2.4);

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;

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

function extentText(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return `(${Math.min(...xs).toFixed(2)}, ${Math.min(...ys).toFixed(2)}) - (${Math.max(...xs).toFixed(2)}, ${Math.max(...ys).toFixed(2)})`;
}

function addPolygon(ring, label, fillColor, lineColor, checked) {
  const style = {
    fillColor,
    fillOpacity: checked ? 165 : 125,
    lineColor,
    lineWidth: checked ? 4.0 : 2.4,
    showLabels: true,
    labelField: "LABEL",
    labelFontSize: 12.0,
    labelColor: "#111111",
    labelHaloEnabled: true,
    labelHaloColor: "#FFFFFF",
    labelHaloWidth: 2.5,
  };
  if (!viewer.addPolygonShapeWithAttributes(ring, { LABEL: label }, style)) {
    throw new Error("Polygon shape could not be rendered.");
  }
}

function renderScene(checked) {
  const currentExtent = checked ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  addPolygon(VALID, "A - valid polygon", "#BFD7EA", "#2F80C2", false);
  addPolygon(BOW_TIE, "B - self-intersecting polygon", "#F6D6AD", "#D95D39", false);
  const details = [
    "CheckShape - geometry validation", "", "This sample compares two polygon rings:", "",
    "A - valid polygon", "Closed ring, non-zero area, no self-intersection.", `Extent: ${extentText(VALID)}`, "",
    "B - self-intersecting polygon", "Bow-tie ring crosses itself, so CheckShape must reject it.",
    `Extent: ${extentText(BOW_TIE)}`,
  ];
  if (!checked) {
    details.push("", "Click Run CheckShape to validate both polygons.");
    viewer.setStatusText("Two polygons are ready. Click Run CheckShape.");
  } else {
    const validOk = viewer.checkPolygonRing(VALID);
    const bowTieOk = viewer.checkPolygonRing(BOW_TIE);
    details.push(
      "", "Result:", `A - valid polygon: CheckShape = ${validOk ? "valid" : "invalid"}`,
      `B - self-intersecting polygon: CheckShape = ${bowTieOk ? "valid" : "invalid"}`, "",
      "Invalid means the geometry should be fixed or rejected before topology operations.",
    );
    addPolygon(VALID, "A - CheckShape: valid", "#CDE7D8", "#2A9D8F", true);
    addPolygon(BOW_TIE, "B - CheckShape: invalid", "#F4A261", "#D62828", true);
    viewer.setStatusText("Topology check completed.");
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
    if (viewer.isVisible()) { viewerWasVisible = true; viewerHiddenSince = 0; }
    else if (viewerWasVisible) {
      if (viewerHiddenSince === 0) viewerHiddenSince = Date.now();
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

async function start() {
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: "TopologyCheck", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run CheckShape" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`TopologyCheck failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("TopologyCheck details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  renderScene(false);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
