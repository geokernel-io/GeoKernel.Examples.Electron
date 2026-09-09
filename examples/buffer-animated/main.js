"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerTool, ViewerWindow, extent, findBinDir } = require("geokernel-electron");

const MIN_DISTANCE = 0.35;
const MAX_DISTANCE = 3.0;
const DISTANCE_STEP = 0.08;
const FULL_EXTENT = extent(-4.2, -3.5, 4.2, 3.5);
const CONTROL = Object.freeze({ PLAY_PAUSE: 1, FULL_EXTENT: 2, INTERVAL: 3, DISTANCE: 4 });
const PULSE_STYLE = Object.freeze({ fillColor: "#FFFFFF", fillOpacity: 0, lineColor: "#D95D39", lineWidth: 1.3 });
const POINT_STYLE = Object.freeze({
  fillColor: "#D95D39", fillOpacity: 255, lineColor: "#7A2F1E",
  lineWidth: 1.2, pointColor: "#D95D39", pointSize: 13.0,
});

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let animationTimer = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let playing = true;
let interval = 60;
let distance = MIN_DISTANCE;
let direction = 1;
let frame = 0;

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

function bufferStyle() {
  const ratio = (distance - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE);
  return { fillColor: "#78B7D0", fillOpacity: 55 + Math.trunc(ratio * 90), lineColor: "#1E6F8C", lineWidth: 2.2 };
}

function renderFrame() {
  if (!viewer || closing) return;
  viewer.clearShapes();
  const bufferCreated = viewer.addPointBufferShape(0, 0, distance, 18, bufferStyle());
  const pulseDistance = Math.max(MIN_DISTANCE, distance - 0.28);
  const pulseCreated = viewer.addPointBufferShape(0, 0, pulseDistance, 18, PULSE_STYLE);
  const pointCreated = viewer.addPointShape(0, 0, POINT_STYLE);
  if (!bufferCreated || !pulseCreated || !pointCreated) throw new Error("Animated buffer frame could not be rendered.");

  viewer.clearLog();
  viewer.appendLog([
    "Timer animated buffer", "Operation: MakeBuffer(point, distance)", `Frame: ${frame}`,
    `Distance: ${distance.toFixed(2)} map units`, "Source point: (0.00, 0.00)",
    "Result parts: 1", `Result extent: (${(-distance).toFixed(2)}, ${(-distance).toFixed(2)}) - (${distance.toFixed(2)}, ${distance.toFixed(2)})`,
    "Segments per quadrant: 18",
  ].join("\n"));
  viewer.setControlValue(CONTROL.DISTANCE, `${distance.toFixed(2)} units`);
  viewer.invalidateRenderCache(false, true);
  viewer.refreshLayers();
  viewer.setStatusText(`Animated point buffer: frame ${frame}, distance ${distance.toFixed(2)}`);
}

function advanceFrame() {
  if (!playing || closing || !viewer) return;
  distance += DISTANCE_STEP * direction;
  if (distance >= MAX_DISTANCE) { distance = MAX_DISTANCE; direction = -1; }
  else if (distance <= MIN_DISTANCE) { distance = MIN_DISTANCE; direction = 1; }
  frame += 1;
  try { renderFrame(); }
  catch (error) {
    stopAnimation();
    viewer?.setStatusText(`Animated buffer failed: ${error.message}`);
    console.error(error?.stack || error);
  }
}

function startAnimation() {
  stopAnimation();
  if (!playing || closing) return;
  animationTimer = setInterval(advanceFrame, interval);
}

function stopAnimation() {
  if (animationTimer) clearInterval(animationTimer);
  animationTimer = null;
}

function onControlChanged(controlId, numericValue) {
  if (!viewer || !controlsReady) return;
  if (controlId === CONTROL.PLAY_PAUSE) {
    playing = !playing;
    if (playing) startAnimation(); else stopAnimation();
  } else if (controlId === CONTROL.FULL_EXTENT) viewer.setViewExtent(FULL_EXTENT);
  else if (controlId === CONTROL.INTERVAL) {
    interval = Math.max(20, Math.min(200, Math.round(Number(numericValue))));
    if (playing) startAnimation();
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
  viewer = new ViewerWindow({ title: "Buffer Animated", width: 980, height: 680, navigationToolbar: false });
  viewer.addControlPanel({
    title: "Animated buffer",
    width: 240,
    controls: [
      { id: CONTROL.PLAY_PAUSE, type: "button", text: "Play / Pause" },
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      { id: CONTROL.INTERVAL, type: "number", label: "Interval", value: interval, minimum: 20, maximum: 200, step: 10, decimals: 0, suffix: " ms" },
      { id: CONTROL.DISTANCE, type: "text", label: "Distance", value: `${distance.toFixed(2)} units`, readOnly: true },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Animation details");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  startEventPump();
  controlsReady = true;
  renderFrame();
  viewer.setViewExtent(FULL_EXTENT);
  startAnimation();
}

function stop() {
  stopAnimation();
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
