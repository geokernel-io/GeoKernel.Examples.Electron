"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const koffi = require("koffi");
const { Globe, GlobeNavigation, findBinDir, configureRuntimeEnvironment } = require("geokernel-electron");

configureRuntimeEnvironment(findBinDir());
// Qt reads the C runtime's PATH, which Node's process.env does not update.
// Keep its DLL search path in sync so TLS uses the SDK's matching libraries.
const setNativeEnvironment = koffi.load("ucrtbase.dll").func("int __cdecl _wputenv_s(str16, str16)");
if (setNativeEnvironment("PATH", process.env.PATH) !== 0) {
  throw new Error("Cannot configure the native SDK library search path.");
}

const home = {
  longitude: 2.1744, latitude: 41.4036, targetHeightMetres: 40,
  distanceMetres: 2500, pitchDegrees: 0.65 * 180 / Math.PI, headingDegrees: 0,
};
const toolbarHeight = 80;
const statusHeight = 24;
const positionWindow = koffi.load("user32.dll").func(
  "bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)",
);
let window = null;
let globe = null;
let timer = null;
let esri = -1;

function resize() {
  if (!window || !globe) return;
  const [width, height] = window.getContentSize();
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  globe.resize(width, Math.max(1, height - toolbarHeight - statusHeight));
  // Place the native child above Chromium while leaving the HTML controls visible.
  if (!positionWindow(globe.nativeHandle(), null, 0, Math.round(toolbarHeight * scale), 0, 0, 0x0011)) {
    throw new Error("Cannot position the Globe window.");
  }
}

function updateStatus() {
  if (!window || !globe) return;
  const options = globe.options;
  const messages = [];
  if (options.basemap >= 0) messages.push(globe.getAttribution());
  if (options.terrainEnabled) messages.push("Terrain: Esri / source contributors");
  messages.push(...Object.values(globe.getState().errors || {}).filter(Boolean));
  window.webContents.send("globe:state", {
    options,
    message: messages.filter(Boolean).join(" | ") || "Left: pan | Right / wheel: zoom | Middle / Ctrl: orbit",
  });
}

async function start() {
  window = new BrowserWindow({
    width: 1200, height: 800, minWidth: 750, minHeight: 480,
    title: "GlobeTerrainNavigation — GeoKernel", show: false,
    icon: path.join(__dirname, "../../images/GeoKernelAppIcon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("globe:toggle", (event, key, enabled) => {
    if (!window || !globe || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || typeof enabled !== "boolean") return;
    if (!["atmosphereEnabled", "basemap", "terrainEnabled", "sunlightEnabled"].includes(key)) return;
    globe.options = { ...globe.options, [key]: key === "basemap" ? (enabled ? esri : -1) : enabled };
    updateStatus();
  });
  ipcMain.handle("globe:navigate", (event, action) => {
    if (!window || !globe || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || typeof action !== "string") return;
    if (!Object.hasOwn(GlobeNavigation, action)) return;
    globe.navigate(GlobeNavigation[action]);
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  const handle = window.getNativeWindowHandle();
  const parentWindow = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  globe = new Globe({
    parentWindow, autoPump: true, camera: home,
    options: {
      networkEnabled: true, terrainEnabled: true, atmosphereEnabled: true,
      sunlightEnabled: true, terrainMaxZoom: 14, terrainLerc: true,
    },
  });
  esri = globe.getBasemaps().find((source) => source.name === "Esri Satellite")?.id ?? -1;
  if (esri < 0) throw new Error("Esri Satellite basemap is unavailable.");
  globe.options = { ...globe.options, basemap: esri };
  globe.setHomeCamera(home);
  resize();
  globe.show();
  window.show();
  updateStatus();
  timer = setInterval(updateStatus, 250);
}

function stop() {
  clearInterval(timer);
  timer = null;
  globe?.close();
  globe = null;
  ipcMain.removeHandler("globe:toggle");
  ipcMain.removeHandler("globe:navigate");
}

module.exports = { start, stop };
