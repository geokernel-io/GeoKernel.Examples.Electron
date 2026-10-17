"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const koffi = require("koffi");
const { Globe, GlobeInteraction, findBinDir, configureRuntimeEnvironment } = require("geokernel-electron");
const { ensureSampleFile } = require("../common/sample-data");

configureRuntimeEnvironment(findBinDir());
// Qt reads the C runtime's PATH, which Node's process.env does not update.
// Keep its DLL search path in sync so TLS uses the SDK's matching libraries.
const setNativeEnvironment = koffi.load("ucrtbase.dll").func("int __cdecl _wputenv_s(str16, str16)");
if (setNativeEnvironment("PATH", process.env.PATH) !== 0) {
  throw new Error("Cannot configure the native SDK library search path.");
}

const positionWindow = koffi.load("user32.dll").func(
  "bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)",
);
const layer = "buildings";
let window = null, globe = null, home = null;
let esri = -1, fields = [], busy = false, loaded = false, style, opacity = 0.6;

function report(message) {
  if (!window || window.isDestroyed() || !globe) return;
  window.webContents.send("globe:state", {
    message, busy, loaded, fields, style, opacity, esri: globe.options.basemap >= 0,
  });
}

function summary() {
  const stats = globe.getLayerState(layer).statistics;
  report(`${stats.features} buildings | ${stats.outlineOnly} outline-only | Click to identify | ${globe.getAttribution()}`);
}

function resize() {
  if (!window || !globe) return;
  const [width, height] = window.getContentSize();
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  globe.resize(width, Math.max(1, height - 40 - 24));
  if (!positionWindow(globe.nativeHandle(), null, 0, Math.round(40 * scale), 0, 0, 0x0011))
    throw new Error("Cannot position the Globe window.");
}

async function waitJob(job) {
  const session = globe;
  try { await session.waitJob(job); }
  finally {
    if (!session.closed && ["completed", "failed", "cancelled"].includes(session.getJobState(job).status))
      session.forgetJob(job);
  }
}

async function loadBuildings() {
  busy = true;
  report("Preparing buildings…");
  try {
    let buildings;
    for (const extension of ["shp", "shx", "dbf", "prj"]) {
      const file = await ensureSampleFile(
        "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/sagrada_familia_buildings.zip",
        "sagrada_familia_buildings.zip", "sagrada_familia_buildings", `buildings.${extension}`,
        { onDownloadProgress: (percent) => report(`Downloading buildings… ${percent ?? ""}%`),
          onExtracting: () => report("Extracting buildings…") },
      );
      if (!globe) return;
      if (extension === "shp") buildings = file;
    }
    report("Loading Sagrada Familia buildings…");
    await waitJob(globe.loadVector({ id: layer, path: buildings, sourceCrs: "EPSG:25831", style }));
    if (!globe) return;
    fields = globe.getLayerState(layer).statistics.fields;
    if (!fields.includes("type") || !fields.includes("name"))
      throw new Error("Expected building fields 'type' and 'name' are missing.");
    globe.setLayerOpacity(layer, opacity);
    globe.focusLayer(layer);
    home = { ...globe.camera, distanceMetres: globe.camera.distanceMetres * 0.28,
      pitchDegrees: 1.32 * 180 / Math.PI, headingDegrees: 0.60 * 180 / Math.PI };
    globe.camera = home;
    globe.setHomeCamera(home);
    globe.setInteractionMode(GlobeInteraction.Identify);
    loaded = true;
    busy = false;
    summary();
  } catch (error) { busy = false; report(error.message); }
}

async function start() {
  loaded = false;
  fields = [];
  opacity = 0.6;
  style = { fill: true, labels: false, categoryField: "type", labelField: "name",
    baseColor: "#efb84c", labelSize: 12 };
  window = new BrowserWindow({
    width: 1200, height: 800, minWidth: 1000, minHeight: 480, show: false,
    title: "GlobeVectorStyling — GeoKernel",
    icon: path.join(__dirname, "../../images/GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("globe:change", async (event, key, value) => {
    if (!window || !globe || !loaded || busy || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) return;
    if (key === "zoom") { globe.camera = home; return; }
    if (key === "esri" && typeof value === "boolean") {
      globe.setBasemap(value ? esri : -1); summary(); return;
    }
    if (key === "opacity" && Number.isFinite(value) && value >= 0.15 && value <= 1) {
      globe.setLayerOpacity(layer, value); opacity = value; summary(); return;
    }
    const valid = (["fill", "labels"].includes(key) && typeof value === "boolean") ||
      (key === "categoryField" && (value === "" || fields.includes(value))) ||
      (key === "labelField" && fields.includes(value)) ||
      (key === "baseColor" && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
    if (!valid) return;
    busy = true;
    report("Applying building style…");
    try {
      const next = { ...style, [key]: value };
      await waitJob(globe.setVectorStyle(layer, next));
      style = next;
      busy = false;
      if (globe) summary();
    } catch (error) { busy = false; report(error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  if (!window) return;
  window.show();
  const handle = window.getNativeWindowHandle();
  const parentWindow = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  globe = new Globe({ parentWindow, autoPump: true,
    camera: { longitude: 2.1744, latitude: 41.4036, targetHeightMetres: 0,
      distanceMetres: 2500, pitchDegrees: 75.63, headingDegrees: 34.38 },
    options: { networkEnabled: true, atmosphereEnabled: true },
  });
  esri = globe.getBasemaps().find((item) => item.name === "Esri Satellite")?.id ?? -1;
  if (esri < 0) throw new Error("Esri Satellite basemap is unavailable.");
  globe.setBasemap(esri);
  globe.on("nativeError", (error) => report(error.message));
  globe.on("event", (event) => {
    if (event.type !== "featurePicked" || !event.data.hit) return;
    try {
      const id = String(event.data.featureId);
      const info = globe.getFeatureInfo(layer, id);
      report(`Building ${id}: ` + Object.entries(info.attributes).map(([key, value]) => `${key}: ${value}`).join(" | "));
    } catch (error) { report(error.message); }
  });
  resize();
  globe.show();
  await loadBuildings();
}

function stop() {
  loaded = false;
  globe?.close();
  globe = null;
  ipcMain.removeHandler("globe:change");
}

module.exports = { start, stop };


