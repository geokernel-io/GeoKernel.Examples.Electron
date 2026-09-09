"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

function rectangle(xMin, yMin, xMax, yMax) {
  return [[xMin, yMin], [xMax, yMin], [xMax, yMax], [xMin, yMax], [xMin, yMin]];
}

function diamond(cx, cy, radiusX, radiusY) {
  return [[cx, cy + radiusY], [cx + radiusX, cy], [cx, cy - radiusY], [cx - radiusX, cy], [cx, cy + radiusY]];
}

function createSourcePolygons() {
  const polygons = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const x = -5.4 + column * 2.35 + (row % 2) * 0.45;
      const y = -2.2 + row * 1.55;
      polygons.push(rectangle(x, y, x + 2.15, y + 1.35));
    }
  }
  polygons.push(diamond(-2.8, 1.2, 1.45, 1.0));
  polygons.push(diamond(2.2, -0.9, 1.35, 0.9));
  return polygons;
}

const POLYGONS = createSourcePolygons();
const FULL_EXTENT = extent(-6.5, -3.0, 5.8, 3.6);
const FILLS = ["#BFD7EA", "#D8EAC4", "#F3D6A3", "#D9C8F0", "#BFE3D9", "#F0C7C7"];
const LINES = ["#2F80C2", "#5B8E3E", "#B7791F", "#7048A8", "#2D6A4F", "#B23A48"];
const INVALID_STYLE = {
  fillColor: "#F4A261", fillOpacity: 165, lineColor: "#D62828", lineWidth: 3,
  showLabels: true, labelField: "LABEL", labelFontSize: 10, labelColor: "#7A0010",
  labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
};
const UNION_STYLE = {
  fillColor: "#F9C74F", fillOpacity: 135, lineColor: "#D95D39", lineWidth: 4,
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

function sourceStyle(index, validated) {
  return {
    fillColor: FILLS[index % FILLS.length], fillOpacity: validated ? 135 : 90,
    lineColor: LINES[index % LINES.length], lineWidth: validated ? 2.2 : 1.5,
    showLabels: true, labelField: "LABEL", labelFontSize: 9.5, labelColor: "#202124",
    labelHaloEnabled: true, labelHaloColor: "#FFFFFF", labelHaloWidth: 2,
  };
}

function extentText(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return `(${Math.min(...xs).toFixed(2)}, ${Math.min(...ys).toFixed(2)}) - (${Math.max(...xs).toFixed(2)}, ${Math.max(...ys).toFixed(2)})`;
}

function normalizeParts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => Array.isArray(part)
    ? part.map((point) => [Number(point.x ?? point[0]), Number(point.y ?? point[1])])
    : []).filter((part) => part.length > 0);
}

function addSource(index, validated, valid) {
  const style = valid ? sourceStyle(index, validated) : INVALID_STYLE;
  const label = valid ? `P${index + 1}` : `P${index + 1} invalid`;
  if (!viewer.addPolygonShapeWithAttributes(POLYGONS[index], { LABEL: label }, style)) {
    throw new Error(`Source polygon P${index + 1} could not be rendered.`);
  }
}

function renderScene(runBatch) {
  const currentExtent = runBatch ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  const details = [
    "TopologyBatch", "Batch flow: CheckShape each polygon, then UnionOnList(valid polygons).", "",
    `Source polygon count: ${POLYGONS.length}`,
  ];

  if (!runBatch) {
    POLYGONS.forEach((polygon, index) => addSource(index, false, true));
    details.push("", "Click Run Batch to validate all polygons and build the union.");
    viewer.setStatusText("Source polygons are ready. Click Run Batch.");
  } else {
    const validPolygons = [];
    let invalidCount = 0;
    let sourceVertexCount = 0;
    details.push("", "Validation:");
    POLYGONS.forEach((polygon, index) => {
      const valid = Boolean(viewer.checkPolygonRing(polygon));
      sourceVertexCount += polygon.length;
      details.push(`P${index + 1}: ${valid ? "valid" : "invalid"}, vertices=${polygon.length}, extent=${extentText(polygon)}`);
      if (valid) validPolygons.push(polygon);
      else invalidCount += 1;
      addSource(index, true, valid);
    });
    details.push(
      "", `Valid polygons used for union: ${validPolygons.length}`,
      `Invalid polygons skipped: ${invalidCount}`, `Source vertex total: ${sourceVertexCount}`,
    );

    const started = performance.now();
    const result = normalizeParts(viewer.unionPolygonsOnList(validPolygons));
    const elapsed = performance.now() - started;
    if (result.length > 0) {
      if (!viewer.addPolygonPartsShapeWithAttributes(
        result, { LABEL: "batch union result" }, UNION_STYLE,
      )) throw new Error("Batch union result could not be rendered.");
      const vertices = result.reduce((total, part) => total + part.length, 0);
      details.push(
        "", "Union result:", "Type: polygon", `Parts: ${result.length}`,
        `Vertices: ${vertices}`, `Extent: ${extentText(result.flat())}`,
        `Elapsed: ${elapsed.toFixed(2)} ms`,
      );
      viewer.setStatusText(`Batch topology completed: ${validPolygons.length} valid polygon(s), ${elapsed.toFixed(2)} ms.`);
    } else {
      details.push("", "Union result: empty", `Elapsed: ${elapsed.toFixed(2)} ms`);
      viewer.setStatusText("Batch topology returned an empty result.");
    }
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
    title: "TopologyBatch", width: 1040, height: 680, navigationToolbar: false,
  });
  viewer.addCommandToolbar([
    { id: 1, text: "Full Extent" },
    { id: 2, text: "Batch: CheckShape + UnionOnList", enabled: false },
    { id: 3, text: "Run Batch" },
  ], (id) => {
    try {
      if (id === 1) viewer.setViewExtent(FULL_EXTENT);
      else if (id === 3) renderScene(true);
    } catch (error) {
      viewer.setStatusText(`TopologyBatch failed: ${error.message}`);
      console.error(error?.stack || error);
    }
  });
  viewer.addLogPanel("TopologyBatch details");
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
