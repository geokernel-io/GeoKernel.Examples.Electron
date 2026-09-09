"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const SOURCE = [
  [-5.8, -1.8], [-5.4, -0.6], [-4.9, 0.2], [-4.2, 1.0], [-3.5, 1.6],
  [-2.7, 1.9], [-2.0, 1.5], [-1.2, 2.1], [-0.3, 1.7], [0.5, 2.0],
  [1.4, 1.2], [2.2, 1.4], [3.0, 0.6], [3.8, 0.9], [4.7, 0.1],
  [5.2, -0.9], [4.2, -1.4], [3.1, -1.1], [2.1, -1.8], [1.1, -1.3],
  [0.1, -2.0], [-0.9, -1.5], [-1.9, -2.1], [-2.8, -1.5], [-3.8, -1.9],
  [-4.7, -1.2], [-5.8, -1.8],
];
const FULL_EXTENT = extent(-7.2, -3.0, 6.8, 3.1);
const CONTROL = Object.freeze({ FULL_EXTENT: 1, TOLERANCE: 2 });
const SOURCE_STYLE = {
  fillColor: "#BFD7EA", fillOpacity: 80, lineColor: "#6C757D", lineWidth: 2,
  pointColor: "#2F80C2", pointSize: 7, showLabels: true, labelField: "LABEL",
  labelFontSize: 11, labelColor: "#202124", labelHaloEnabled: true,
  labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
};
const RESULT_STYLE = {
  fillColor: "#F6D6AD", fillOpacity: 150, lineColor: "#D95D39", lineWidth: 4,
  pointColor: "#C1121F", pointSize: 10, showLabels: true, labelField: "LABEL",
  labelFontSize: 11, labelColor: "#4B2415", labelHaloEnabled: true,
  labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
};

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let tolerance = 0.45;

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

function normalizePoints(value) {
  if (!Array.isArray(value)) return [];
  return value.map((point) => [Number(point.x ?? point[0]), Number(point.y ?? point[1])]);
}

function extentText(points) {
  if (points.length === 0) return "(empty)";
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return `(${Math.min(...xs).toFixed(2)}, ${Math.min(...ys).toFixed(2)}) - (${Math.max(...xs).toFixed(2)}, ${Math.max(...ys).toFixed(2)})`;
}

function renderScene(preserveExtent) {
  const currentExtent = preserveExtent ? viewer.getViewExtent() : null;
  const simplified = normalizePoints(viewer.simplifyPolygonRing(SOURCE, tolerance));
  viewer.clearShapes();

  if (!viewer.addPolygonShapeWithAttributes(
    SOURCE, { LABEL: `source: ${SOURCE.length} vertices` }, SOURCE_STYLE,
  )) throw new Error("Source polygon could not be rendered.");

  if (simplified.length > 0 && !viewer.addPolygonShapeWithAttributes(
    simplified, { LABEL: `simplified: tolerance ${tolerance.toFixed(2)}` }, RESULT_STYLE,
  )) throw new Error("Simplified polygon could not be rendered.");

  const details = [
    "shape.simplify(tolerance)", "Algorithm: Douglas-Peucker", "",
    `Tolerance: ${tolerance.toFixed(2)} map units`,
    `Source polygon vertices: ${SOURCE.length}`,
    `Source extent: ${extentText(SOURCE)}`,
    "Source parts:", `part 1: ${SOURCE.length} vertices`, "",
  ];
  if (simplified.length > 0) {
    details.push(
      `Simplified polygon vertices: ${simplified.length}`,
      `Removed vertices: ${SOURCE.length - simplified.length}`,
      `Simplified extent: ${extentText(simplified)}`,
      "Simplified parts:", `part 1: ${simplified.length} vertices`,
    );
  } else details.push("Simplified result: empty");

  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(currentExtent ?? FULL_EXTENT);
  viewer.setStatusText(`Simplify applied with tolerance ${tolerance.toFixed(2)}.`);
}

function onControlChanged(controlId, numericValue) {
  if (!viewer || !controlsReady) return;
  try {
    if (controlId === CONTROL.FULL_EXTENT) viewer.setViewExtent(FULL_EXTENT);
    else if (controlId === CONTROL.TOLERANCE) {
      tolerance = Math.max(0, Math.min(2, Number(numericValue)));
      renderScene(true);
    }
  } catch (error) {
    viewer.setStatusText(`ShapeSimplify failed: ${error.message}`);
    console.error(error?.stack || error);
  }
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
    title: "ShapeSimplify", width: 1040, height: 680, navigationToolbar: false,
  });
  viewer.addControlPanel({
    title: "Shape simplify",
    width: 235,
    controls: [
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      {
        id: CONTROL.TOLERANCE, type: "number", label: "Tolerance", value: tolerance,
        minimum: 0, maximum: 2, step: 0.05, decimals: 2, suffix: " units",
      },
    ],
  }, onControlChanged);
  viewer.addLogPanel("ShapeSimplify details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  controlsReady = true;
  renderScene(false);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  if (viewer) {
    try { viewer.close(); } catch { /* Native window may already be gone. */ }
  }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
