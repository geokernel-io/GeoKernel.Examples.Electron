"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const PARTS = [
  [[-5.0, -1.7], [-1.7, -1.7], [-1.7, 1.6], [-5.0, 1.6], [-5.0, -1.7]],
  [[0.4, -1.7], [4.5, 1.6], [0.4, 1.6], [4.5, -1.7], [0.4, -1.7]],
];
const FULL_EXTENT = extent(-5.7, -2.8, 5.2, 2.6);
const SOURCE_STYLE = {
  fillColor: "#F6D6AD", fillOpacity: 115, lineColor: "#D95D39", lineWidth: 2.4,
  showLabels: true, labelField: "LABEL", labelFontSize: 11.5, labelColor: "#111111",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2.0,
};
const RESULT_STYLE = {
  fillColor: "#CDE7D8", fillOpacity: 170, lineColor: "#2A9D8F", lineWidth: 4.0,
  showLabels: true, labelField: "LABEL", labelFontSize: 11.5, labelColor: "#111111",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2.0,
};

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

function normalizeParts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => Array.isArray(part)
    ? part.map((point) => [Number(point.x ?? point[0]), Number(point.y ?? point[1])])
    : []).filter((part) => part.length > 0);
}

function renderScene(showResult) {
  const currentExtent = showResult ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  if (!viewer.addPolygonPartsShapeWithAttributes(
    PARTS,
    { LABEL: "source: one valid part, one self-intersecting loop" },
    SOURCE_STYLE,
  )) throw new Error("Source polygon could not be rendered.");

  const details = [
    "FindAndDeleteLoops - remove self-intersecting polygon parts", "", "Source geometry:",
    "- left part is a normal valid rectangle", "- right part is a bow-tie loop that crosses itself", "",
    `Source parts: ${PARTS.length}`, `Source vertices: ${PARTS.reduce((sum, part) => sum + part.length, 0)}`,
    "Source extent: (-5.00, -1.70) - (4.50, 1.60)", "Source part details:",
    "part 1: 5 vertices", "part 2: 5 vertices",
  ];
  if (showResult) {
    const result = normalizeParts(viewer.findAndDeleteLoops(PARTS));
    if (!viewer.addPolygonPartsShapeWithAttributes(result, { LABEL: "result: loop removed" }, RESULT_STYLE)) {
      throw new Error("FindAndDeleteLoops result could not be rendered.");
    }
    details.push(
      "", "Result:", `Result parts: ${result.length}`,
      `Result vertices: ${result.reduce((sum, part) => sum + part.length, 0)}`,
      "Result extent: (-5.00, -1.70) - (-1.70, 1.60)", "Result part details:",
      "part 1: 5 vertices", "", "The self-intersecting bow-tie part is removed; the valid part remains.",
    );
    viewer.setStatusText("FindAndDeleteLoops result created.");
  } else {
    details.push("", "Click Run FindAndDeleteLoops to remove the self-intersecting part.");
    viewer.setStatusText("Source polygon is ready. Click Run FindAndDeleteLoops.");
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
  viewer = new ViewerWindow({ title: "FindDeleteLoops", width: 980, height: 680, navigationToolbar: false });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Run FindAndDeleteLoops" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 2) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`FindDeleteLoops failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("FindDeleteLoops details");
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
