"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const LEFT = [[-4.0, -1.4], [0.7, -1.4], [0.7, 2.0], [-4.0, 2.0], [-4.0, -1.4]];
const RIGHT = [[-1.0, -2.1], [3.9, -2.1], [3.9, 1.3], [-1.0, 1.3], [-1.0, -2.1]];
const FULL_EXTENT = extent(-5.1, -3.0, 5.0, 3.0);
const PATTERNS = [
  ["EQUALITY", "T*F**FF*"], ["DISJOINT", "FF*FF"], ["INTERSECT", "T"],
  ["WITHIN", "T*F**F"], ["CONTAINS", "T*****FF*"], ["TOUCH", "F***T"],
  ["CROSS", "T*T"], ["OVERLAP", "T*T***T"],
];
const STYLE_A = {
  fillColor: "#BFD7EA", fillOpacity: 140, lineColor: "#2F80C2", lineWidth: 2.2,
  showLabels: true, labelField: "LABEL", labelFontSize: 12, labelColor: "#17324D",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
};
const STYLE_B = {
  fillColor: "#F6D6AD", fillOpacity: 135, lineColor: "#D95D39", lineWidth: 2.2,
  showLabels: true, labelField: "LABEL", labelFontSize: 12, labelColor: "#4B2415",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
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

function renderScene(showRelate) {
  const currentExtent = showRelate ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  const leftAdded = viewer.addPolygonShapeWithAttributes(LEFT, { LABEL: "Polygon A" }, STYLE_A);
  const rightAdded = viewer.addPolygonShapeWithAttributes(RIGHT, { LABEL: "Polygon B" }, STYLE_B);
  if (!leftAdded || !rightAdded) throw new Error("Source polygons could not be rendered.");

  const details = [
    "Relate(left, right)",
    "DE-9IM style relation string returned by GisTopology::Relate.", "",
    `Polygon A extent: ${extentText(LEFT)}`,
    `Polygon B extent: ${extentText(RIGHT)}`,
  ];
  if (!showRelate) {
    details.push("", "Click Run Relate to calculate the relation matrix.");
    viewer.setStatusText("Source polygons are ready. Click Run Relate.");
  } else {
    const matrix = viewer.relatePolygonRings(LEFT, RIGHT);
    details.push("", `Relate matrix: ${matrix}`, "", "Pattern matches:");
    for (const [name, pattern] of PATTERNS) {
      const matches = viewer.relatePolygonRingsPattern(LEFT, RIGHT, pattern);
      details.push(`${name} (${pattern}): ${matches ? "true" : "false"}`);
    }
    viewer.setStatusText(`Relate matrix calculated: ${matrix}`);
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
    title: "SpatialRelate", width: 980, height: 680, navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Operation: Relate(left, right)", enabled: false },
    { id: 3, text: "Run Relate" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 3) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`SpatialRelate failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("SpatialRelate details");
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
