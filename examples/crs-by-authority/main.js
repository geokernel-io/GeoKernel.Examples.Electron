"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { ViewerWindow, findBinDir } = require("geokernel-electron");

const CONTROL = Object.freeze({ AUTHORITY: 1, CODE: 2, RESOLVE: 3 });

let viewer = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let authority = "EPSG";
let code = 32635;

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
  return match?.[1] ?? `${crs.authName ?? "CRS"}:${crs.authSrid ?? crs.srid ?? "-"}`;
}

function crsKind(crs) {
  const definition = String(crs.srText ?? "").toUpperCase();
  if (/^(PROJCRS|PROJCS)\[/.test(definition)) return "Projected";
  if (/^(GEOGCRS|GEOGCS)\[/.test(definition)) return "Geographic";
  if (/^(VERTCRS|VERT_CS)\[/.test(definition)) return "Vertical";
  return "Unknown";
}

function resolveCrs() {
  const normalizedAuthority = authority.trim().toUpperCase();
  const normalizedCode = Math.max(1, Math.trunc(code));
  const authorityCode = `${normalizedAuthority}:${normalizedCode}`;
  const crs = viewer.coordinateSystemFromAuthority(normalizedAuthority, normalizedCode);
  if (!crs?.found) {
    viewer.setCentralText(crs?.error || `${authorityCode} could not be resolved.`);
    viewer.setStatusText("Lookup failed.");
    return;
  }

  const name = crsName(crs);
  viewer.setCentralText([
    `CoordinateSystemFactory::fromUserInput("${authorityCode}")`,
    "",
    `EPSG code: ${crs.srid ?? crs.authSrid ?? normalizedCode}`,
    `Name: ${name}`,
    `Kind: ${crsKind(crs)}`,
    "",
    "PROJ definition",
    crs.proj4Text || "-",
    "",
    "Definition",
    crs.srText || "-",
  ].join("\n"));
  viewer.setStatusText(`${authorityCode} - ${name} | Resolved with GDAL/PROJ.`);
}

function onControlChanged(controlId, numericValue, textValue) {
  setImmediate(() => {
    if (!viewer) return;
    try {
      if (controlId === CONTROL.AUTHORITY) authority = textValue || authority;
      else if (controlId === CONTROL.CODE) code = numericValue;
      else if (controlId === CONTROL.RESOLVE) resolveCrs();
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
    title: "CRS by Authority (GDAL/PROJ)",
    width: 1040,
    height: 760,
    navigationToolbar: false,
  });
  viewer.setCentralTextPanel("Resolving EPSG:32635...");
  viewer.addControlPanel({
    title: "CRS lookup",
    area: "left",
    width: 250,
    controls: [
      {
        id: CONTROL.AUTHORITY,
        type: "combo",
        label: "Authority",
        options: ["EPSG", "ESRI", "IGNF"],
        value: authority,
      },
      {
        id: CONTROL.CODE,
        type: "number",
        label: "Code",
        value: code,
        minimum: 1,
        maximum: 999999,
        step: 1,
        decimals: 0,
      },
      { id: CONTROL.RESOLVE, type: "button", text: "Resolve" },
    ],
  }, onControlChanged);
  viewer.setStatusText("Resolving EPSG:32635...");
  viewer.show();
  viewer.processEvents();
  startEventPump();
  resolveCrs();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  authority = "EPSG";
  code = 32635;
  if (viewer) viewer.close();
  viewer = null;
  if (keeperWindow) keeperWindow.close();
  keeperWindow = null;
}

module.exports = { start, stop };
