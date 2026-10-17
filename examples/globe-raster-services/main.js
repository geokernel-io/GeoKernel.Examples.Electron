"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const koffi = require("koffi");
const { Globe, findBinDir, configureRuntimeEnvironment } = require("geokernel-electron");
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
let window = null, globe = null, errorTimer = null;

function report(message) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("globe:status", message);
}

function checkErrors() {
  if (!globe) return;
  try {
    const error = Object.values(globe.getState().errors).find((value) => value);
    report(error || `Sagrada Familia orthophoto + DEM | Elevation 1x | ${globe.getAttribution()}`);
  } catch (error) { report(error.message); }
}

function resize() {
  if (!window || !globe) return;
  const [width, height] = window.getContentSize();
  globe.resize(width, Math.max(1, height - 24));
  if (!positionWindow(globe.nativeHandle(), null, 0, 0, 0, 0, 0x0011))
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

async function loadRasters() {
  const session = globe;
  try {
    const files = [];
    for (const name of ["sagrada_familia_ortophoto", "sagrada_familia_terrain"]) {
      files.push(await ensureSampleFile(
        `https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/${name}.zip`,
        `${name}.zip`, name, `${name}.tif`,
        { onDownloadProgress: (percent) => report(`Downloading ${name}… ${percent ?? ""}%`),
          onExtracting: () => report(`Extracting ${name}…`) },
      ));
      if (session.closed) return;
    }
    report("Loading Sagrada orthophoto…");
    await waitJob(session.loadRaster({ id: "ortho", path: files[0] }));
    if (session.closed) return;
    report("Loading Sagrada DEM…");
    await waitJob(session.loadDem({ id: "dem", path: files[1] }));
    if (session.closed) return;
    const stats = session.getLayerState("dem").statistics;
    // Elevation remains active; DEM colors must not cover the orthophoto.
    session.setDemStyle(false, stats.minimum, stats.maximum);
    session.options = { ...session.options, terrainEnabled: true, terrainExaggeration: 1 };
    session.focusLayer("ortho");
    const camera = { ...session.camera, distanceMetres: session.camera.distanceMetres * .6,
      pitchDegrees: 1.32 * 180 / Math.PI, headingDegrees: .6 * 180 / Math.PI };
    session.camera = camera;
    session.setHomeCamera(camera);
    checkErrors();
    errorTimer = setInterval(checkErrors, 500);
  } catch (error) { if (!session.closed) report(error.message); }
}

async function start() {
  window = new BrowserWindow({
    width: 1200, height: 800, minWidth: 1000, minHeight: 480, show: false,
    title: "GlobeRasterServices — GeoKernel",
    icon: path.join(__dirname, "../../images/GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
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
  const esri = globe.getBasemaps().find((item) => item.name === "Esri Satellite")?.id ?? -1;
  if (esri < 0) throw new Error("Esri Satellite basemap is unavailable.");
  globe.setBasemap(esri);
  globe.on("nativeError", (error) => report(error.message));
  resize();
  globe.show();
  await loadRasters();
}

function stop() {
  clearInterval(errorTimer);
  errorTimer = null;
  globe?.close();
  globe = null;

}

module.exports = { start, stop };


