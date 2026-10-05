"use strict";

const path = require("path");
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
let modelReady = false;
let visible = true;
const defaultPlacement = [2.174401283, 41.403605046, 2.938, .2373346, 0, 0, .958139];

function status(message) {
  if (window && !window.isDestroyed()) {
    window.webContents.send("terrain:status", { message, busy, modelReady });
  }
}

function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}

async function load(resolution = 512, placement = defaultPlacement) {
  if (busy || !viewer) return;
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
    const model = await ensureSampleFile(
      "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/sagrada_familia_3d_model.zip",
      "sagrada_familia_3d_model.zip", "sagrada_familia_3d_model", "model.gltf",
      { onDownloadProgress: (percent) => status(`Downloading model… ${percent ?? ""}%`), onExtracting: () => status("Extracting model…") },
    );
    if (!viewer) return;
    if (cancelled) { busy = false; status("Loading cancelled."); return; }
    const geoid = await ensureSampleFile(
      "https://icgc-web-pro.s3.eu-central-1.amazonaws.com/produccio/s3fs-public/EGM08D595_19839.zip",
      "EGM08D595.zip", "egm08d595", "EGM08D595/cat80000.gr",
      { onDownloadProgress: (percent) => status(`Downloading geoid… ${percent ?? ""}%`), onExtracting: () => status("Extracting geoid…") },
    );
    if (!viewer) return;
    if (cancelled) { busy = false; status("Loading cancelled."); return; }
    viewer.load(file, photo, model, geoid, placement, resolution);
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
    title: "ModelPlacement — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("terrain:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try {
      if (!viewer) return;
      if (action === "reload" && value && [256, 512, 1024].includes(value.resolution) &&
          Array.isArray(value.placement) && value.placement.length === 7 &&
          value.placement.every(Number.isFinite) && value.placement.every((v, i) =>
            v >= [-180, -90, -500, -180, -180, -180, .01][i] && v <= [180, 90, 1000, 180, 180, 180, 100][i])) {
        await load(value.resolution, value.placement);
      }
      else if (action === "cancel") { cancelled = true; viewer.cancel(); }
      else if (action === "imagery" && typeof value === "boolean") { imagery = value; viewer.imagery(imagery); }
      else if (action === "height" && Number.isFinite(value) && value >= 0.25 && value <= 10) { height = value; viewer.height(height); }
      else if (action === "visible" && typeof value === "boolean") { visible = value; viewer.modelVisible(visible); }
      else if (action === "focus" && modelReady) viewer.focusModel();
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
        modelReady = true;
        viewer.modelVisible(visible);
        viewer.focusModel();
        status(`Model loaded — ${(viewer.modelVertexCount() / 3).toLocaleString()} triangles; EGM08D595 corrected terrain`);
      } else throw new Error("Terrain loading ended without a scene.");
    } catch (error) {
      loading = busy = false;
      status(error.message);
    }
  }, 16);
  await load();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  viewer?.close();
  viewer = null;
  loading = busy = false;
  ipcMain.removeHandler("terrain:action");
}

module.exports = { start, stop };
