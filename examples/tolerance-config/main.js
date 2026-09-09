"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const BASELINE = [[-4.5, 0.0], [4.5, 0.0]];
const TEST_POINT = [0.0, 0.35];
const FULL_EXTENT = extent(-5.2, -1.8, 5.2, 2.4);
const CONTROL = Object.freeze({ FULL_EXTENT: 1, TOLERANCE: 2 });
const LINE_STYLE = { lineColor: "#1F6F8B", lineWidth: 3, pointColor: "#1F6F8B", pointSize: 7 };

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let tolerance = 0.25;

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

function toleranceCircle(radius) {
  const ring = [];
  for (let index = 0; index <= 72; index += 1) {
    const angle = 2 * Math.PI * index / 72;
    ring.push([
      TEST_POINT[0] + Math.cos(angle) * radius,
      TEST_POINT[1] + Math.sin(angle) * radius,
    ]);
  }
  return ring;
}

function normalizePoint(value) {
  return [Number(value.x ?? value[0]), Number(value.y ?? value[1])];
}

function renderScene(preserveExtent) {
  const currentExtent = preserveExtent ? viewer.getViewExtent() : null;
  const info = viewer.linePointToleranceInfo(
    BASELINE, TEST_POINT[0], TEST_POINT[1], tolerance,
  );
  const crossings = Array.isArray(info.crossings) ? info.crossings.map(normalizePoint) : [];
  const intersects = Boolean(info.intersects);
  const configuredTolerance = Number(info.tolerance ?? tolerance);
  const active = crossings.length > 0 || intersects;
  const activeColor = active ? "#2A9D8F" : "#D95D39";

  viewer.clearShapes();
  if (tolerance > 0 && !viewer.addPolygonShape(toleranceCircle(tolerance), {
    fillColor: active ? "#CDE7D8" : "#F6D6AD",
    fillOpacity: 75, lineColor: activeColor, lineWidth: 2,
  })) throw new Error("Tolerance circle could not be rendered.");
  if (!viewer.addPolylineShape(BASELINE, LINE_STYLE)) {
    throw new Error("Baseline could not be rendered.");
  }
  if (!viewer.addPointShape(TEST_POINT[0], TEST_POINT[1], {
    pointColor: active ? "#2A9D8F" : "#C1121F",
    lineColor: active ? "#145A4B" : "#7A0010", lineWidth: 1.3, pointSize: 12,
  })) throw new Error("Test point could not be rendered.");
  for (const [x, y] of crossings) {
    if (!viewer.addPointShape(x, y, {
      pointColor: "#FFD166", lineColor: "#9A6700", lineWidth: 1.5, pointSize: 15,
    })) throw new Error("Accepted crossing point could not be rendered.");
  }

  const resultText = active
    ? "The point is accepted as touching/intersecting the line within tolerance."
    : "The point is outside the configured tolerance.";
  viewer.clearLog();
  viewer.appendLog([
    "GisTopology::SetTolerance", "", "Scenario:", "- Baseline is y = 0.",
    "- Test point is at (0.00, 0.35).", "- Point-to-line distance is 0.35 map units.", "",
    `Configured tolerance: ${configuredTolerance.toFixed(2)}`,
    `GetCrossings(line, point): ${crossings.length} point(s)`,
    `Intersect(line, point): ${intersects ? "true" : "false"}`, "", "Result:", resultText, "",
    "Visual guide:", "Circle: current tolerance radius around the point",
    "Green: tolerance reaches the line", "Orange/red: tolerance is too small",
  ].join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(currentExtent ?? FULL_EXTENT);
  viewer.setStatusText(`Topology tolerance: ${configuredTolerance.toFixed(2)} map units.`);
}

function onControlChanged(controlId, numericValue) {
  if (!viewer || !controlsReady) return;
  try {
    if (controlId === CONTROL.FULL_EXTENT) viewer.setViewExtent(FULL_EXTENT);
    else if (controlId === CONTROL.TOLERANCE) {
      tolerance = Math.max(0, Math.min(1, Number(numericValue)));
      renderScene(true);
    }
  } catch (error) {
    viewer.setStatusText(`ToleranceConfig failed: ${error.message}`);
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
    title: "ToleranceConfig", width: 1040, height: 680, navigationToolbar: false,
  });
  viewer.addControlPanel({
    title: "Topology tolerance",
    width: 235,
    controls: [
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      {
        id: CONTROL.TOLERANCE, type: "number", label: "Tolerance", value: tolerance,
        minimum: 0, maximum: 1, step: 0.01, decimals: 2, suffix: " units",
      },
    ],
  }, onControlChanged);
  viewer.addLogPanel("ToleranceConfig details");
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
