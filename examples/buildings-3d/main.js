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
let buildingsReady = false;
let buildingStyle = { visible: true, opacity: 1, color: "#d9c4a5" };

function status(message) {
  if (window && !window.isDestroyed()) {
    window.webContents.send("terrain:status", { message, busy, buildingsReady });
  }
}

function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}

async function load(resolution = 512, buildingHeight = 9) {
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
    let buildings;
    for (const extension of ["shp", "shx", "dbf", "prj"]) {
      const component = await ensureSampleFile(
        "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/sagrada_familia_buildings.zip",
        "sagrada_familia_buildings.zip", "sagrada_familia_buildings", `buildings.${extension}`,
        {
          onDownloadProgress: (percent) => status(percent === null ? "Downloading buildings…" : `Downloading buildings… ${percent}%`),
          onExtracting: () => status("Extracting buildings…"),
        },
      );
      if (!viewer) return;
      if (cancelled) {
        busy = false;
        status("Loading cancelled.");
        return;
      }
      if (extension === "shp") buildings = component;
    }
    viewer.load(file, photo, buildings, buildingHeight, resolution);
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
    title: "Buildings3D — GeoKernel", backgroundColor: "#090f16",
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
          Number.isFinite(value.buildingHeight) && value.buildingHeight >= 1 && value.buildingHeight <= 300) {
        await load(value.resolution, value.buildingHeight);
      }
      else if (action === "cancel") { cancelled = true; viewer.cancel(); }
      else if (action === "imagery" && typeof value === "boolean") { imagery = value; viewer.imagery(imagery); }
      else if (action === "height" && Number.isFinite(value) && value >= 0.25 && value <= 10) { height = value; viewer.height(height); }
      else if (action === "buildings" && buildingsReady && value && typeof value === "object") {
        viewer.buildingStyle(value.visible, value.opacity, value.color);
        buildingStyle = { visible: value.visible, opacity: value.opacity, color: value.color };
      }
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
        buildingsReady = true;
        viewer.buildingStyle(buildingStyle.visible, buildingStyle.opacity, buildingStyle.color);
        status(`Terrain, orthophoto and buildings loaded — ${viewer.buildingVertexCount().toLocaleString()} building vertices`);
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
