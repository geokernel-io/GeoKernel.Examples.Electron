"use strict";

const path = require("path");
const { CameraNavigation } = require("./camera-navigation");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { TerrainViewer } = require("./terrain-viewer");

let window = null;
let viewer = null;
let timer = null;
let busy = false;
let loading = false;
let cancelled = false;
let imagery = true;
let height = 1;
let navigation = null;
let telemetry = null;

function status(message) {
  if (window && !window.isDestroyed()) {
    window.webContents.send("terrain:status", { message, busy, ready: !!navigation?.home });
  }
}

function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}

async function load(resolution = 512) {
  if (busy || !viewer) return;
  viewer.stopCamera();
  busy = true;
  cancelled = false;
  status("Preparing terrain…");
  try {
    const file = await ensureSampleFile(
      "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/sagrada_familia_terrain.zip",
      "sagrada_familia_terrain.zip", "sagrada_familia_terrain", "sagrada_familia_terrain.tif",
      {
        onDownloadProgress: (percent) => status(percent === null ? "Downloading DEM…" : `Downloading DEM… ${percent}%`),
        onExtracting: () => status("Extracting DEM…"),
      },
    );
    if (!viewer) return;
    if (cancelled) {
      busy = false;
      status("Loading cancelled.");
      return;
    }
    const photo = await ensureSampleFile(
      "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/sagrada_familia_ortophoto.zip",
      "sagrada_familia_ortophoto.zip", "sagrada_familia_ortophoto", "sagrada_familia_ortophoto.tif",
      {
        onDownloadProgress: (percent) => status(percent === null ? "Downloading orthophoto..." : `Downloading orthophoto... ${percent}%`),
        onExtracting: () => status("Extracting orthophoto..."),
      },
    );
    if (!viewer) return;
    if (cancelled) {
      busy = false;
      status("Loading cancelled.");
      return;
    }
    viewer.load(file, photo, resolution);
    loading = true;
    status("Loading terrain…");
  } catch (error) {
    busy = false;
    status(error.message);
  }
}

async function start() {
  window = new BrowserWindow({
    width: 1200, height: 800, minWidth: 700, minHeight: 500,
    title: "CameraNavigation — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("terrain:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try {
      if (!viewer || typeof action !== "string") return;
      if (action.startsWith("camera:") && !busy && navigation?.home) {
        const result = navigation.action(action.slice(7), value);
        window.webContents.send("camera:state", navigation.state());
        return result;
      }
      if (action === "reload" && [256, 512, 1024].includes(value)) await load(value);
      else if (action === "cancel") { cancelled = true; viewer.cancel(); }
      else if (action === "imagery" && typeof value === "boolean") { imagery = value; viewer.imagery(imagery); }
      else if (action === "height" && Number.isFinite(value) && value >= 0.25 && value <= 10) { height = value; viewer.height(height); }
      else if (action === "reset") viewer.reset();
    } catch (error) { status(error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  window.show();
  viewer = new TerrainViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
  navigation = new CameraNavigation(viewer, path.join(app.getPath("userData"), "camera-navigation-sagrada-v1.json"));
  telemetry = setInterval(() => {
    if (window && !window.isDestroyed() && navigation?.home && !busy)
      window.webContents.send("camera:state", navigation.state());
  }, 150);
  resize();
  viewer.imagery(imagery);
  timer = setInterval(() => {
    if (!viewer) return;
    viewer.pump();
    if (!viewer || !loading) return;
    try {
      const result = viewer.poll();
      if (result === 0) return;
      loading = busy = false;
      if (result === -2) status("Loading cancelled.");
      else if (result === 1) {
        viewer.imagery(imagery);
        viewer.height(height);
        navigation.home = viewer.camera();
        status("Terrain and orthophoto loaded");
      } else throw new Error("Terrain loading ended without a scene.");
    } catch (error) {
      loading = busy = false;
      status(error.message);
    }
  }, 16);
  await load();
}

function stop() {
  if (telemetry) clearInterval(telemetry);
  telemetry = null;
  navigation = null;
  if (timer) clearInterval(timer);
  timer = null;
  viewer?.close();
  viewer = null;
  loading = busy = false;
  ipcMain.removeHandler("terrain:action");
}

module.exports = { start, stop };
