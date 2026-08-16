"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerWindow, findBinDir } = require("geokernel-electron");

const CONTROL = Object.freeze({ CODE: 1, LOOKUP: 2 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let epsgCode = 4326;

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH
      ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll")
      : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function crsName(crs) {
  const match = String(crs.srText ?? "").match(/^[A-Z_]+\["([^"]+)"/i);
  return match?.[1] ?? `EPSG:${crs.authSrid ?? crs.srid ?? epsgCode}`;
}

function crsKind(crs) {
  const definition = String(crs.srText ?? "").toUpperCase();
  if (/^(PROJCRS|PROJCS)\[/.test(definition)) return "Projected";
  if (/^(GEOGCRS|GEOGCS)\[/.test(definition)) return "Geographic";
  if (/^(VERTCRS|VERT_CS)\[/.test(definition)) return "Vertical";
  return "Unknown";
}

function metersPerUnit(crs) {
  const value = Number(crs.metersPerUnit);
  return Number.isFinite(value) ? String(value) : "n/a";
}

function resolveEpsg() {
  const normalizedCode = Math.max(1, Math.min(999999, Math.trunc(epsgCode)));
  const crs = viewer.coordinateSystemFromEpsg(normalizedCode);
  if (!crs?.found) {
    viewer.setCentralText(crs?.error || `EPSG:${normalizedCode} could not be resolved.`);
    viewer.setStatusText("Lookup failed.");
    return;
  }

  const resolvedCode = crs.authSrid ?? crs.srid ?? normalizedCode;
  const name = crsName(crs);
  viewer.setCentralText([
    `CoordinateSystemFactory::fromEpsg(${normalizedCode})`,
    "",
    `Name: ${name}`,
    `Kind: ${crsKind(crs)}`,
    `Meters per unit: ${metersPerUnit(crs)}`,
    "",
    "Definition",
    crs.srText || crs.proj4Text || "-",
  ].join("\n"));
  viewer.setStatusText(`EPSG:${resolvedCode} — ${name} | Resolved with GDAL/PROJ.`);
}

function onControlChanged(controlId, numericValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      if (controlId === CONTROL.CODE) epsgCode = numericValue;
      else if (controlId === CONTROL.LOOKUP) resolveEpsg();
    } catch (error) {
      viewer?.setCentralText(`Lookup failed\n\n${error.message}`);
      viewer?.setStatusText("Lookup failed.");
      console.error(error?.stack || error);
    }
  });
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
      if (Date.now() - viewerHiddenSince > 750) app.quit();
    }
  }, 16);
}

async function start() {
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true },
  });
  viewer = new ViewerWindow({
    title: "EPSG lookup (GDAL/PROJ)",
    width: 1000,
    height: 720,
    navigationToolbar: false,
  });
  viewer.setCentralTextPanel("Resolving EPSG:4326...");
  viewer.addControlPanel({
    title: "CRS database",
    area: "top",
    controls: [
      {
        id: CONTROL.CODE,
        type: "number",
        label: "EPSG",
        value: epsgCode,
        minimum: 1,
        maximum: 999999,
        step: 1,
        decimals: 0,
      },
      { id: CONTROL.LOOKUP, type: "button", text: "Find EPSG" },
    ],
  }, onControlChanged);
  viewer.setStatusText("Resolving EPSG:4326...");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  resolveEpsg();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  epsgCode = 4326;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
