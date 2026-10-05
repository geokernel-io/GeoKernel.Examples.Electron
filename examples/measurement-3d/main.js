"use strict";

const path = require("path");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { MeasurementViewer } = require("./terrain-viewer");

let window, viewer, timer;
let busy = false, loading = false, ready = false, cancelled = false;
let lastSnapshot = null, nextPoll = 0;
const settings = { imagery: true, area: false, capture: true, height: 1 };

function send(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}
function status(message) { send("measurement:status", { message, busy, ready }); }
function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}
function measurement() {
  if (!ready || busy || !viewer) return;
  const snapshot = viewer.measurement();
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastSnapshot) return;
  lastSnapshot = serialized;
  send("measurement:result", snapshot);
}
function restore() {
  if (!ready || !viewer) return;
  viewer.mode(settings.area, settings.capture);
  measurement();
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
    if (ready) viewer.mode(settings.area, false);
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
    title: "Measurement3D — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("measurement:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !viewer) return;
    try {
      if (action === "reload") { await load(); return; }
      if (action === "cancel") { cancelled = true; viewer.cancel(); return; }
      if (!ready || busy) return;
      if (action === "imagery" && typeof value === "boolean") {
        settings.imagery = value;
        viewer.imagery(value);
      } else if ((action === "area" || action === "capture") && typeof value === "boolean") {
        settings[action] = value;
        viewer.mode(settings.area, settings.capture);
      } else if (action === "finish") {
        settings.capture = false;
        viewer.mode(settings.area, false);
      } else if (action === "height" && Number.isFinite(value) && value >= .25 && value <= 10) {
        settings.height = value;
        viewer.height(value);
      } else if (action === "undo") viewer.edit(true);
      else if (action === "clear") viewer.edit(false);
      else if (action === "reset") viewer.reset();
      measurement();
    } catch (error) { status(error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  viewer = new MeasurementViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
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
            status("Ready — click terrain to measure.");
          } else if (result === -2) status("Loading cancelled.");
          else throw new Error("Loading ended without a scene.");
          restore();
        }
      }
      if (Date.now() >= nextPoll) {
        nextPoll = Date.now() + 150;
        measurement();
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
  ipcMain.removeHandler("measurement:action");
}

module.exports = { start, stop };
