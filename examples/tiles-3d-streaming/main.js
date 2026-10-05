"use strict";

const path = require("path");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { TilesViewer } = require("./terrain-viewer");

let window, viewer, timer, source, pendingSource;
let busy = false, loading = false, ready = false, cancelled = false, resume = false;
let nextPoll = 0, previousState = null;
const settings = { imagery: true, visible: true, budget: 96 };

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}
function status(message) { send("tiles:status", { message, busy, ready, visible: settings.visible }); }
function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}
function refresh() {
  if (!ready || busy || !viewer) return;
  const state = viewer.tilesState();
  const serialized = JSON.stringify(state);
  if (serialized === previousState) return;
  previousState = serialized;
  send("tiles:state", state);
}
function startTiles() {
  if (!ready || !source || !viewer) return;
  viewer.startTiles(source, settings.budget);
  settings.visible = true;
}
function complete() {
  busy = loading = false;
  if (resume && ready && viewer) startTiles();
  previousState = null;
  refresh();
}
async function sample(name, required, url) {
  const result = await ensureSampleFile(
    url || `https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/${name}.zip`,
    `${name}.zip`, name, required, {
      onDownloadProgress: (percent) => status(`Downloading ${name}${percent === null ? "…" : `… ${percent}%`}`),
      onExtracting: () => status(`Extracting ${name}…`),
    });
  if (cancelled || !viewer) throw new Error("Loading cancelled.");
  return result;
}
async function load() {
  if (busy || !viewer) return;
  busy = true;
  cancelled = resume = false;
  status("Preparing sample…");
  try {
    if (ready) { resume = viewer.tilesState().active; viewer.stopTiles(); }
    const dem = await sample("sagrada_familia_terrain", "sagrada_familia_terrain.tif");
    const image = await sample("sagrada_familia_ortophoto", "sagrada_familia_ortophoto.tif");
    pendingSource = await sample("sagrada_familia_3d_tiles", "tileset.json");
    const geoid = await sample("egm08d595", "EGM08D595/cat80000.gr",
      "https://icgc-web-pro.s3.eu-central-1.amazonaws.com/produccio/s3fs-public/EGM08D595_19839.zip");
    viewer.loadTilesTerrain(dem, image, geoid, pendingSource);
    loading = true;
    status("Loading corrected terrain…");
  } catch (error) {
    try { complete(); } catch (restoreError) { send("tiles:error", restoreError.message); }
    status(error.message);
  }
}

async function start() {
  window = new BrowserWindow({
    width: 1400, height: 850, minWidth: 700, minHeight: 500,
    title: "Tiles3DStreaming — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("tiles:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !viewer) return;
    try {
      if (action === "reload") { await load(); return; }
      if (action === "cancel") { cancelled = true; viewer.cancel(); return; }
      if (!ready || busy) return;
      if (action === "start" && Number.isInteger(value) && value >= 64 && value <= 128) {
        settings.budget = value;
        startTiles();
      } else if (action === "stop") viewer.stopTiles();
      else if (action === "visible" && typeof value === "boolean") {
        if (value) startTiles();
        else viewer.stopTiles(true);
        settings.visible = value;
      } else if (action === "imagery" && typeof value === "boolean") {
        viewer.imagery(value);
        settings.imagery = value;
      } else if (action === "focus") viewer.focusTiles();
      else if (action === "reset") viewer.reset();
      send("tiles:error", "");
      status("Terrain loaded — camera movement controls tile detail.");
      refresh();
    } catch (error) { send("tiles:error", error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  viewer = new TilesViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
  resize();
  timer = setInterval(() => {
    if (!viewer) return;
    try {
      viewer.pump();
      if (!viewer) return;
      if (loading) {
        const result = viewer.poll();
        if (result !== 0) {
          if (result === 1) {
            ready = true;
            source = pendingSource;
            viewer.imagery(settings.imagery);
            resume = settings.visible;
          } else if (result !== -2) throw new Error("Loading ended without a scene.");
          complete();
          status(result === -2 ? "Loading cancelled." : "Terrain loaded — camera movement controls tile detail.");
        }
      }
      if (Date.now() >= nextPoll) { nextPoll = Date.now() + 500; refresh(); }
    } catch (error) {
      if (loading) {
        try { complete(); } catch (restoreError) { send("tiles:error", restoreError.message); }
      }
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
  ipcMain.removeHandler("tiles:action");
}

module.exports = { start, stop };
