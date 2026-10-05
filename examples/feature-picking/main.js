"use strict";

const path = require("path");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { FeaturePickingViewer } = require("./terrain-viewer");

let window, viewer, timer;
let busy = false, loading = false, ready = false, cancelled = false;
let revision = null, nextSelectionPoll = 0;
const settings = { imagery: true, buildings: true, roads: true, multiple: false, height: 1 };

function send(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}
function status(message) { send("picking:status", { message, busy, ready }); }
function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}
function selection() {
  if (!ready || busy || !viewer) return;
  const snapshot = viewer.selection();
  if (snapshot.revision === revision) return;
  revision = snapshot.revision;
  send("picking:selection", snapshot);
}
function applyStyle() {
  viewer.imagery(settings.imagery);
  viewer.buildingStyle(settings.buildings, 1, "#d9c4a5");
  viewer.roads(settings.roads);
  viewer.multiple(settings.multiple);
  viewer.height(settings.height);
}
async function sample(dataset, filename) {
  const name = `sagrada_familia_${dataset}`;
  const result = await ensureSampleFile(
    `https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/${name}.zip`,
    `${name}.zip`, name, filename, {
      onDownloadProgress: (percent) => status(`Downloading ${dataset}${percent === null ? "…" : `… ${percent}%`}`),
      onExtracting: () => status(`Extracting ${dataset}…`),
    });
  if (cancelled || !viewer) throw new Error("Loading cancelled.");
  return result;
}
async function shapefile(dataset) {
  const file = await sample(dataset, `${dataset}.shp`);
  for (const extension of ["shx", "dbf", "prj"]) {
    const component = await sample(dataset, `${dataset}.${extension}`);
    if (path.dirname(component) !== path.dirname(file)) throw new Error("Shapefile components must share a directory.");
  }
  return file;
}
async function load() {
  if (busy || !viewer) return;
  busy = true;
  cancelled = false;
  status("Preparing sample…");
  try {
    const dem = await sample("terrain", "sagrada_familia_terrain.tif");
    const image = await sample("ortophoto", "sagrada_familia_ortophoto.tif");
    const roads = await shapefile("roads");
    const buildings = await shapefile("buildings");
    viewer.loadFeatures(dem, image, roads, buildings);
    loading = true;
    status("Loading terrain, buildings and roads…");
  } catch (error) {
    busy = false;
    status(error.message);
  }
}

async function start() {
  window = new BrowserWindow({
    width: 1200, height: 850, minWidth: 700, minHeight: 500,
    title: "FeaturePicking — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("picking:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !viewer) return;
    try {
      if (action === "reload") { await load(); return; }
      if (action === "cancel") { cancelled = true; viewer.cancel(); return; }
      if (!ready || busy) return;
      if (["imagery", "buildings", "roads", "multiple"].includes(action) && typeof value === "boolean") {
        settings[action] = value;
        applyStyle();
      } else if (action === "height" && Number.isFinite(value) && value >= .25 && value <= 10) {
        settings.height = value;
        viewer.height(value);
      } else if (action === "activate" && value &&
          [value.revision, value.index].every((id) => typeof id === "string" && /^\d{1,20}$/.test(id) && BigInt(id) <= 18446744073709551615n)) {
        viewer.activate(value.revision, value.index);
      } else if (action === "clear") viewer.clear();
      else if (action === "focus") viewer.focus();
      else if (action === "reset") viewer.reset();
      selection();
    } catch (error) { status(error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  viewer = new FeaturePickingViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
  resize();
  timer = setInterval(() => {
    if (!viewer) return;
    try {
      viewer.pump();
      if (!viewer) return;
      if (loading) {
        const result = viewer.poll();
        if (result !== 0) {
          loading = busy = false;
          if (result === 1) {
            ready = true;
            revision = null;
            applyStyle();
            status("Ready — click a building or road.");
          } else if (result === -2) status("Loading cancelled.");
          else throw new Error("Loading ended without a scene.");
        }
      }
      if (Date.now() >= nextSelectionPoll) {
        nextSelectionPoll = Date.now() + 150;
        selection();
      }
    } catch (error) {
      loading = busy = false;
      status(error.message);
    }
  }, 16);
  await load();
}

function stop() {
  cancelled = true;
  if (timer) clearInterval(timer);
  timer = null;
  viewer?.close();
  viewer = null;
  loading = busy = ready = false;
  ipcMain.removeHandler("picking:action");
}

module.exports = { start, stop };
