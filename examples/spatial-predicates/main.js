"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

function rectangle(xMin, yMin, xMax, yMax) {
  return [[xMin, yMin], [xMax, yMin], [xMax, yMax], [xMin, yMax], [xMin, yMin]];
}

const CASES = [
  { name: "Contains", pattern: "T*****FF*", left: rectangle(-8.2, 3.5, -4.8, 6.3), right: rectangle(-7.4, 4.1, -5.7, 5.5) },
  { name: "Within", pattern: "T*F**F", left: rectangle(-2.8, 4.1, -1.1, 5.5), right: rectangle(-3.6, 3.5, -0.2, 6.3) },
  { name: "Touches", pattern: "F***T", left: rectangle(1.2, 3.6, 3.4, 6.1), right: rectangle(3.4, 3.6, 5.6, 6.1) },
  { name: "Overlaps", pattern: "T*T***T", left: rectangle(-8.2, -2.0, -5.0, 0.8), right: rectangle(-6.3, -0.8, -3.1, 2.0) },
  { name: "Cross", pattern: "T*T", left: [[-2.9, -1.7], [0.4, 1.6]], right: [[-2.9, 1.6], [0.4, -1.7]], polyline: true },
  { name: "Disjoint", pattern: "FF*FF", left: rectangle(1.4, -2.0, 3.0, -0.2), right: rectangle(4.2, 0.2, 5.8, 2.0) },
];
const FULL_EXTENT = extent(-9.2, -3.2, 6.8, 7.2);
const LEFT_STYLE = {
  fillColor: "#BFD7EA", fillOpacity: 135, lineColor: "#2F80C2", lineWidth: 2,
  showLabels: true, labelField: "LABEL", labelFontSize: 10.5, labelColor: "#17324D",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
};
const RIGHT_STYLE = {
  fillColor: "#F6D6AD", fillOpacity: 130, lineColor: "#D95D39", lineWidth: 2,
  showLabels: true, labelField: "LABEL", labelFontSize: 10.5, labelColor: "#4B2415",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
};
const LINE_LEFT_STYLE = { fillOpacity: 0, lineColor: "#2F80C2", lineWidth: 3 };
const LINE_RIGHT_STYLE = { fillOpacity: 0, lineColor: "#D95D39", lineWidth: 3 };

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

function renderScene() {
  viewer.clearShapes();
  const details = [
    "Spatial predicate examples",
    "Each pair is arranged so the named predicate should evaluate to true.", "",
  ];

  for (const predicate of CASES) {
    let matrix;
    let result;
    if (predicate.polyline) {
      if (!viewer.addPolylineShape(predicate.left, LINE_LEFT_STYLE)
          || !viewer.addPolylineShape(predicate.right, LINE_RIGHT_STYLE)) {
        throw new Error(`${predicate.name} polylines could not be rendered.`);
      }
      matrix = viewer.relatePolylines(predicate.left, predicate.right);
      result = viewer.relatePolylinesPattern(predicate.left, predicate.right, predicate.pattern);
    } else {
      const leftAdded = viewer.addPolygonShapeWithAttributes(
        predicate.left, { LABEL: `${predicate.name} A` }, LEFT_STYLE,
      );
      const rightAdded = viewer.addPolygonShapeWithAttributes(
        predicate.right, { LABEL: `${predicate.name} B` }, RIGHT_STYLE,
      );
      if (!leftAdded || !rightAdded) throw new Error(`${predicate.name} polygons could not be rendered.`);
      matrix = viewer.relatePolygonRings(predicate.left, predicate.right);
      result = viewer.relatePolygonRingsPattern(predicate.left, predicate.right, predicate.pattern);
    }
    details.push(
      `${predicate.name}(left, right)`,
      `  result: ${result ? "true" : "false"}`,
      `  matrix: ${matrix}`,
      `  left extent: ${extentText(predicate.left)}`,
      `  right extent: ${extentText(predicate.right)}`, "",
    );
  }

  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(FULL_EXTENT);
  viewer.setStatusText("Spatial predicates evaluated.");
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
    title: "SpatialPredicates", width: 1040, height: 720, navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Predicates: Contains / Within / Touches / Overlaps / Cross / Disjoint", enabled: false },
  ], (id) => {
    if (id === 1) viewer.setViewExtent(FULL_EXTENT);
  });
  viewer.addLogPanel("Spatial predicate results");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  renderScene();
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
