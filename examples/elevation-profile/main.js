"use strict";

const path = require("path");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { ElevationProfileViewer } = require("./terrain-viewer");

let window, viewer, timer;
let busy = false, loading = false, ready = false, cancelled = false;
let lastSnapshot = null, nextPoll = 0;
const settings = { imagery: true, spacing: 10, capture: true, height: 1 };

function send(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}
function status(message) { send("profile:status", { message, busy, ready }); }
function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height - 240, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}
function profile() {
  if (!ready || busy || !viewer) return;
  const snapshot = viewer.profile();
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastSnapshot) return;
  lastSnapshot = serialized;
  send("profile:result", snapshot);
}
function restore() {
  if (!ready || !viewer) return;
  viewer.mode(settings.capture, settings.spacing);
  profile();
}
async function sample(dataset) {
  const name = `sagrada_familia_${dataset}`;
  const file = await ensureSampleFile(
    `https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/${name}.zip`,
    `${name}.zip`, name, `${name}.tif`, {
      onDownloadProgress: (percent) => status(`Downloading ${dataset}${percent === null ? "…" : `… ${percent}%`}`),
      onExtracting: () => status(`Extracting ${dataset}…`),
    });
  if (cancelled || !viewer) throw new Error("Loading cancelled.");
  return file;
}
async function load() {
  if (busy || !viewer) return;
  busy = true;
  cancelled = false;
  status("Preparing sample…");
  try {
    if (ready) viewer.mode(false, settings.spacing);
    const dem = await sample("terrain");
    const image = await sample("ortophoto");
    viewer.loadTerrain(dem, image);
    loading = true;
    status("Loading terrain…");
  } catch (error) {
    busy = false;
    status(error.message);
    restore();
  }
}

async function start() {
  window = new BrowserWindow({
    width: 1300, height: 850, minWidth: 700, minHeight: 500,
    title: "ElevationProfile — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("profile:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !viewer) return;
    try {
      if (action === "reload") { await load(); return; }
      if (action === "cancel") { cancelled = true; viewer.cancel(); return; }
      if (!ready || busy) return;
      if (action === "imagery" && typeof value === "boolean") {
        settings.imagery = value;
        viewer.imagery(value);
      } else if (action === "capture" && typeof value === "boolean") {
        settings[action] = value;
        viewer.mode(settings.capture, settings.spacing);
      } else if (action === "spacing" && Number.isFinite(value) && value >= 1 && value <= 100) {
        settings.spacing = value;
        viewer.mode(settings.capture, settings.spacing);
      } else if (action === "finish") {
        settings.capture = false;
        viewer.mode(false, settings.spacing);
      } else if (action === "height" && Number.isFinite(value) && value >= .25 && value <= 10) {
        settings.height = value;
        viewer.height(value);
      } else if (action === "undo") viewer.edit(true);
      else if (action === "clear") viewer.edit(false);
      else if (action === "reset") viewer.reset();
      profile();
    } catch (error) { status(error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  viewer = new ElevationProfileViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
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
            lastSnapshot = null;
            viewer.imagery(settings.imagery);
            viewer.height(settings.height);
            status("Ready — click terrain to draw a profile.");
          } else if (result === -2) status("Loading cancelled.");
          else throw new Error("Loading ended without a scene.");
          restore();
        }
      }
      if (Date.now() >= nextPoll) {
        nextPoll = Date.now() + 150;
        profile();
      }
    } catch (error) {
      const wasLoading = loading;
      loading = busy = false;
      status(error.message);
      // Failed replacement loads preserve the previous scene and points.
      if (wasLoading) {
        try { restore(); } catch (restoreError) { status(restoreError.message); }
      }
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
  ipcMain.removeHandler("profile:action");
}

module.exports = { start, stop };
