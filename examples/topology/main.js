"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const POLYGON_A = [[-5, -2], [1, -2], [1, 3], [-5, 3], [-5, -2]];
const POLYGON_B = [[-1, -1], [5, -1], [5, 4], [-1, 4], [-1, -1]];
const DIAGONAL_LINE = [[-6, -3], [6, 4]];
const INVALID_POLYGON = [[3, -6.4], [6.2, -3.2], [3, -3.2], [6.2, -6.4], [3, -6.4]];
const ARC_A = [[-6, -5.5], [-4.4, -4.4], [-2.7, -5.4]];
const ARC_B = [[-2.7, -5.4], [-0.7, -4.2], [1.5, -5.3]];
const SPLIT_ARC = [[-5.7, -6.7], [2.2, -4.1]];
const SPLIT_CUTTER = [[-2, -7.1], [-2, -3.7]];
const FULL_EXTENT = extent(-7.3, -7.4, 7, 5);

const OPERATIONS = Object.freeze([
  "Buffer A",
  "Union A + B",
  "Intersection A / B",
  "Difference A - B",
  "Sym Difference A / B",
  "Convex Hull A + B",
  "Crossings Line / B",
  "Fix Invalid Polygon",
  "Arc Make Connected",
  "Arc Split On Cross",
  "Predicate Report",
]);
const CONTROL = Object.freeze({ FULL_EXTENT: 1, OPERATION: 2 });
const STYLE = Object.freeze({
  polygonA: { fillColor: "#BFD7EA", fillOpacity: 165, lineColor: "#2F80C2", lineWidth: 2 },
  polygonB: { fillColor: "#CDE7D8", fillOpacity: 165, lineColor: "#2D6A4F", lineWidth: 2 },
  invalid: { fillColor: "#F8D7DA", fillOpacity: 115, lineColor: "#B23A48", lineWidth: 2 },
  line: { lineColor: "#2F2F2F", lineWidth: 2 },
  arc: { lineColor: "#6C4AB6", lineWidth: 2 },
  result: { fillColor: "#F9C74F", fillOpacity: 155, lineColor: "#D95D39", lineWidth: 3 },
  resultLine: { lineColor: "#D95D39", lineWidth: 4 },
  resultPoint: { pointColor: "#D95D39", pointSize: 12, lineColor: "#8C321D", lineWidth: 1.5 },
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let operation = OPERATIONS[0];

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

function normalizePoint(point) {
  return [Number(point.x ?? point[0]), Number(point.y ?? point[1])];
}

function normalizeParts(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 0 && !Array.isArray(value[0]) && typeof value[0] === "object") {
    return [value.map(normalizePoint)];
  }
  if (value.length > 0 && Array.isArray(value[0]) && typeof value[0][0] === "number") {
    return [value.map(normalizePoint)];
  }
  return value.map((part) => Array.isArray(part) ? part.map(normalizePoint) : []).filter((part) => part.length > 0);
}

function extentText(parts) {
  const points = parts.flat();
  if (points.length === 0) return "(empty)";
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return `(${Math.min(...xs).toFixed(2)}, ${Math.min(...ys).toFixed(2)}) - (${Math.max(...xs).toFixed(2)}, ${Math.max(...ys).toFixed(2)})`;
}

function addPolygon(points, style) {
  if (!viewer.addPolygonShape(points, style)) throw new Error("Polygon shape could not be rendered.");
}

function addLine(points, style) {
  if (!viewer.addPolylineShape(points, style)) throw new Error("Polyline shape could not be rendered.");
}

function addSources() {
  addPolygon(POLYGON_A, STYLE.polygonA);
  addPolygon(POLYGON_B, STYLE.polygonB);
  addLine(DIAGONAL_LINE, STYLE.line);
  addPolygon(INVALID_POLYGON, STYLE.invalid);
  addLine(ARC_A, STYLE.arc);
  addLine(ARC_B, STYLE.arc);
  addLine(SPLIT_ARC, STYLE.arc);
  addLine(SPLIT_CUTTER, STYLE.line);
}

function addPolygonResult(value, details, label) {
  const parts = normalizeParts(value);
  details.push(`${label}: polygon, parts=${parts.length}, extent=${extentText(parts)}`);
  if (parts.length > 0 && !viewer.addPolygonPartsShape(parts, STYLE.result)) {
    throw new Error(`${label} could not be rendered.`);
  }
  return parts.length;
}

function addLineResult(value, details, label) {
  const parts = normalizeParts(value);
  details.push(`${label}: polyline, parts=${parts.length}, extent=${extentText(parts)}`);
  parts.forEach((part) => addLine(part, STYLE.resultLine));
  return parts.length;
}

function predicateReport() {
  const matrix = viewer.relatePolygonRings(POLYGON_A, POLYGON_B);
  const matches = (pattern) => viewer.relatePolygonRingsPattern(POLYGON_A, POLYGON_B, pattern);
  return [
    "Predicate report for Polygon A and Polygon B",
    `Relate matrix: ${matrix}`,
    `Equality: ${matches("T*F**FFF*")}`,
    `Disjoint: ${matches("FF*FF****")}`,
    `Intersect: ${!matches("FF*FF****")}`,
    `Touch: ${matches("FT*******") || matches("F**T*****") || matches("F***T****")}`,
    `Within A in B: ${matches("T*F**F***")}`,
    `Contains A contains B: ${matches("T*****FF*")}`,
    `Overlap: ${matches("T*T***T**")}`,
    `CheckShape(A): ${viewer.checkPolygonRing(POLYGON_A)}`,
    `CheckShape(bow-tie): ${viewer.checkPolygonRing(INVALID_POLYGON)}`,
    `Line/B crossings: ${viewer.polylineCrossings(DIAGONAL_LINE, POLYGON_B).length}`,
    `ArcFind(Arc B): ${viewer.findMatchingArcIndex(ARC_B, [ARC_A, ARC_B])}`,
    `SplitByArc(A, line): ${normalizeParts(viewer.splitPolygonByArc(POLYGON_A, DIAGONAL_LINE)).length} shape(s)`,
  ];
}

function renderOperation(preserveExtent) {
  const currentExtent = preserveExtent ? viewer.getViewExtent() : null;
  viewer.clearShapes();
  addSources();
  const details = [operation];
  let resultCount = 0;

  switch (operation) {
    case "Buffer A":
      details.push("MakeBuffer(Polygon A, 0.75)");
      if (viewer.addPolygonBufferShape(POLYGON_A, 0.75, 12, STYLE.result)) {
        resultCount = 1;
        details.push("Buffer: polygon, distance=0.75");
      } else details.push("Buffer: empty");
      break;
    case "Union A + B":
      details.push("Combine(Polygon A, Polygon B, Union)");
      resultCount = addPolygonResult(viewer.unionPolygons(POLYGON_A, POLYGON_B), details, "Union");
      break;
    case "Intersection A / B":
      details.push("Intersection(Polygon A, Polygon B)");
      resultCount = addPolygonResult(viewer.intersectionPolygons(POLYGON_A, POLYGON_B), details, "Intersection");
      break;
    case "Difference A - B":
      details.push("Difference(Polygon A, Polygon B)");
      resultCount = addPolygonResult(viewer.differencePolygons(POLYGON_A, POLYGON_B), details, "Difference");
      break;
    case "Sym Difference A / B":
      details.push("SymmetricalDifference(Polygon A, Polygon B)");
      resultCount = addPolygonResult(viewer.symmetricalDifferencePolygons(POLYGON_A, POLYGON_B), details, "Symmetrical difference");
      break;
    case "Convex Hull A + B":
      details.push("ConvexHull(Polygon A, Polygon B)");
      resultCount = addPolygonResult(viewer.convexHullTwoPolygons(POLYGON_A, POLYGON_B), details, "Convex hull");
      break;
    case "Crossings Line / B": {
      details.push("GetCrossings(Line, Polygon B)");
      const crossings = viewer.polylineCrossings(DIAGONAL_LINE, POLYGON_B).map(normalizePoint);
      details.push(`Crossings: ${crossings.length}`);
      crossings.forEach((point, index) => {
        viewer.addPointShape(point[0], point[1], STYLE.resultPoint);
        details.push(`Crossing ${index + 1}: (${point[0].toFixed(2)}, ${point[1].toFixed(2)})`);
      });
      resultCount = crossings.length;
      break;
    }
    case "Fix Invalid Polygon": {
      details.push("FixShape(bow-tie polygon)", `Check before: ${viewer.checkPolygonRing(INVALID_POLYGON)}`);
      const fixed = viewer.fixPolygon(INVALID_POLYGON);
      resultCount = addPolygonResult(fixed, details, "Fixed shape");
      const parts = normalizeParts(fixed);
      details.push(`Check after: ${parts.length > 0 && parts.every((part) => viewer.checkPolygonRing(part))}`);
      break;
    }
    case "Arc Make Connected":
      details.push("ArcMakeConnected(Arc A, [Arc B])");
      resultCount = addLineResult(viewer.arcMakeConnected(ARC_A, [ARC_B]), details, "Connected arc");
      break;
    case "Arc Split On Cross":
      details.push("ArcSplitOnCross(split arc, [vertical cutter])");
      resultCount = addLineResult(viewer.arcSplitOnCross(SPLIT_ARC, [SPLIT_CUTTER]), details, "Split arc");
      break;
    case "Predicate Report":
      details.splice(0, details.length, ...predicateReport());
      break;
    default:
      break;
  }

  viewer.clearLog();
  viewer.appendLog(details.join("\n"));
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setViewExtent(currentExtent ?? FULL_EXTENT);
  viewer.setStatusText(`Topology operation result shapes: ${resultCount}`);
}

function onControlChanged(controlId, numericValue, textValue) {
  if (!controlsReady) return;
  try {
    if (controlId === CONTROL.FULL_EXTENT) viewer.setViewExtent(FULL_EXTENT);
    else if (controlId === CONTROL.OPERATION && OPERATIONS.includes(textValue)) {
      operation = textValue;
      renderOperation(true);
    }
  } catch (error) {
    viewer.setStatusText(`Topology failed: ${error.message}`);
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
  viewer = new ViewerWindow({ title: "Topology", width: 1120, height: 760, navigationToolbar: true });
  viewer.addControlPanel({
    title: "Topology operation",
    width: 275,
    controls: [
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      { id: CONTROL.OPERATION, type: "combo", label: "Operation", options: OPERATIONS, value: operation },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Topology operation details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  controlsReady = true;
  renderOperation(false);
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
