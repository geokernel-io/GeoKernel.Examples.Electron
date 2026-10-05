"use strict";

const path = require("path");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { PointCloudViewer } = require("./point-cloud-viewer");

let window, viewer, timer;
let busy = false, loading = false, ready = false, cancelled = false;
let nextPoll = 0, previousState = null;
const settings = { limit: 250000, height: false };

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}
function status(message) { send("cloud:status", { message, busy, loading, ready, cancelled }); }
function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}
function refresh() {
  if (!ready || busy || !viewer) return;
  const state = viewer.state();
  const serialized = JSON.stringify(state);
  if (serialized === previousState) return;
  previousState = serialized;
  send("cloud:state", state);
}
async function load() {
  if (busy || !viewer) return;
  busy = true;
  cancelled = false;
  status("Preparing sample…");
  try {
    const name = "eurosdr_p4_pointcloud";
    const file = await ensureSampleFile(
      `https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/${name}.zip`,
      `${name}.zip`, name, `${name}.laz`, {
        onDownloadProgress: (percent) => status(`Downloading point cloud… ${percent === null ? "" : `${percent}%`}`),
        onExtracting: () => status("Extracting point cloud…"),
      });
    if (!viewer || cancelled) throw new Error("Loading cancelled.");
    viewer.loadCloud(file, settings.limit);
    loading = true;
    status("Reading and sampling LAZ…");
  } catch (error) {
    busy = loading = false;
    status(error.message);
  }
}

async function start() {
  window = new BrowserWindow({
    width: 1200, height: 800, minWidth: 700, minHeight: 500,
    title: "PointCloudViewer — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("cloud:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !viewer) return;
    try {
      if (action === "cancel" && loading) {
        cancelled = true;
        viewer.cancel();
        status("Cancelling…");
        return;
      }
      if (busy) return;
      if (action === "reload" && [50000, 100000, 250000].includes(value)) {
        settings.limit = value;
        await load();
        return;
      }
      if (!ready) return;
      if (action === "style" && typeof value === "boolean") {
        viewer.style(value);
        settings.height = value;
      } else if (action === "reset") viewer.reset();
      else return;
      send("cloud:error", "");
    } catch (error) { send("cloud:error", error.message); }
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  if (!window || window.isDestroyed()) return;
  viewer = new PointCloudViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
  resize();
  timer = setInterval(() => {
    if (!viewer) return;
    try {
      viewer.pump();
      if (!viewer) return;
      if (loading) {
        const result = viewer.poll();
        if (result !== 0) {
          busy = loading = false;
          if (result === 1) {
            ready = true;
            viewer.style(settings.height);
          } else if (result !== -2) throw new Error("Load ended without a point cloud.");
          previousState = null;
          refresh();
          status(result === -2 ? (ready ? "Cancelled; previous cloud retained." : "Loading cancelled.") : "Point cloud loaded.");
        }
      }
      if (Date.now() >= nextPoll) { nextPoll = Date.now() + 1000; refresh(); }
    } catch (error) {
      busy = loading = false;
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
  busy = loading = ready = false;
  ipcMain.removeHandler("cloud:action");
}

module.exports = { start, stop };
