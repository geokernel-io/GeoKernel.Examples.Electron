"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
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
const layer = "sagrada-familia";
let window = null, globe = null, modelPath = null;
let esri = -1, busy = false, present = false, placement;

function report(message) {
  if (!window || window.isDestroyed() || !globe) return;
  window.webContents.send("globe:state", {
    message, busy, present, placement,
    atmosphere: globe.options.atmosphereEnabled, esri: globe.options.basemap >= 0,
  });
}

function summary() {
  const message = present ? "Approximate placement" : "Model removed — click Restore";
  report(`Sagrada Familia | ${message} | Model: PeeJaa | ${globe.getAttribution()}`);
}

function modelCamera() {
  return { longitude: placement.longitude, latitude: placement.latitude,
    targetHeightMetres: placement.height + 65 * placement.scale,
    distanceMetres: 550 * placement.scale, pitchDegrees: 1.15 * 180 / Math.PI,
    headingDegrees: .6 * 180 / Math.PI };
}

function focusModel() {
  globe.camera = modelCamera();
  globe.setHomeCamera(modelCamera());
}

async function waitForUpload(session) {
  report("Uploading model to the GPU…");
  // A completed geometry job can still have incremental GPU uploads pending.
  while (!session.closed) {
    const state = session.getState();
    if (state.errors.scene) throw new Error(state.errors.scene);
    if (!state.sceneUploadPending && state.sceneVerticesDrawn > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

async function loadModel() {
  busy = true;
  report("Preparing Sagrada Familia model…");
  const session = globe;
  try {
    modelPath = await ensureSampleFile(
      "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/sagrada_familia_3d_model.zip",
      "sagrada_familia_3d_model.zip", "sagrada_familia_3d_model", "model.gltf",
      { onDownloadProgress: (percent) => report(`Downloading model… ${percent ?? ""}%`),
        onExtracting: () => report("Extracting model…") },
    );
    if (session.closed) return;
    report("Loading Sagrada Familia model…");
    await waitJob(session.loadModel({ ...placement, path: modelPath }));
    if (session.closed) return;
    present = true;
    focusModel();
    await waitForUpload(session);
    busy = false;
    if (!session.closed) summary();
  } catch (error) { busy = false; if (!session.closed) report(error.message); }
}

async function placeModel(next) {
  busy = true;
  report("Updating model placement…");
  const session = globe;
  try {
    await waitJob(session.setModelPlacement(next));
    if (session.closed) return;
    placement = next;
    focusModel();
    await waitForUpload(session);
    busy = false;
    if (!session.closed) summary();
  } catch (error) { busy = false; if (!session.closed) report(error.message); }
}

async function start() {
  present = false;
  busy = true;
  modelPath = null;
  placement = { id: layer, name: "Sagrada Familia", longitude: 2.1744, latitude: 41.4036,
    height: 14.089, heading: 0, pitch: 0, roll: 0, scale: 1, heightMode: "ellipsoidal" };
  window = new BrowserWindow({
    width: 1200, height: 800, minWidth: 1000, minHeight: 480, show: false,
    title: "GlobeModelPlacement — GeoKernel",
    icon: path.join(__dirname, "../../images/GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("globe:change", async (event, key, value) => {
    if (!window || !globe || busy || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) return;
    if (key === "zoom") { focusModel(); return; }
    if (key === "esri" && typeof value === "boolean") {
      globe.setBasemap(value ? esri : -1); summary(); return;
    }
    if (key === "atmosphere" && typeof value === "boolean") {
      globe.options = { ...globe.options, atmosphereEnabled: value }; summary(); return;
    }
    if (key === "restore" && !present) { await loadModel(); return; }
    if (!present) return;
    if (key === "remove") {
      globe.removeLayer(layer); present = false; summary(); return;
    }
    if (key === "rotate") {
      await placeModel({ ...placement, heading: (placement.heading + 30) % 360 }); return;
    }
    if (key === "apply") {
      if (!value || !Number.isFinite(value.scale) || value.scale < .01 || value.scale > 10 ||
          !Number.isFinite(value.height) || value.height < -100 || value.height > 10000) {
        report("Enter a scale from 0.01 to 10 and an anchor height from -100 to 10000 m."); return;
      }
      await placeModel({ ...placement, scale: value.scale, height: value.height });
    }
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
    camera: modelCamera(),
    options: { networkEnabled: true, atmosphereEnabled: true },
  });
  esri = globe.getBasemaps().find((item) => item.name === "Esri Satellite")?.id ?? -1;
  if (esri < 0) throw new Error("Esri Satellite basemap is unavailable.");
  globe.setBasemap(esri);
  globe.on("nativeError", (error) => report(error.message));
  resize();
  globe.show();
  await loadModel();
}

function stop() {
  present = false;
  globe?.close();
  globe = null;
  ipcMain.removeHandler("globe:change");
}

module.exports = { start, stop };


