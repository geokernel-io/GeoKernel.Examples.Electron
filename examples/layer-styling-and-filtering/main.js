"use strict";
const path = require("path");
const koffi = require("koffi");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { ensureSampleFile } = require("../common/sample-data");
const { LayerStylingViewer } = require("./terrain-viewer");

let window, viewer, timer;
let busy = false, loading = false, ready = false, cancelled = false;
const settings = { imagery: true, height: 1 };

function status(message) {
  if (window && !window.isDestroyed())
    window.webContents.send("styling:status", { message, busy, ready });
}
function resize() {
  if (!window || !viewer) return;
  const [width, height] = window.getContentSize();
  viewer.resize(width, height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
}
async function sample(dataset, filename) {
  const name = `sagrada_familia_${dataset}`;
  const result = await ensureSampleFile(
    `https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/${name}.zip`,
    `${name}.zip`, name, filename, {
      onDownloadProgress: (percent) => status(`Downloading ${dataset}… ${percent ?? ""}`),
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
    status("Loading terrain, roads and buildings…");
  } catch (error) {
    busy = false;
    status(error.message);
  }
}
function validate(command) {
  if (!command || typeof command !== "object") throw new Error("Invalid style command.");
  const { action, id } = command;
  if (action === "reset") return { action };
  const layer = viewer.layers().find((item) => item.id === id);
  if (!layer) throw new Error("Unknown layer.");
  if (action === "appearance" && typeof command.visible === "boolean" &&
      Number.isFinite(command.opacity) && command.opacity >= 0 && command.opacity <= 1)
    return { action, id, visible: command.visible, opacity: command.opacity };
  if (action === "color" && typeof command.color === "string" && /^(|#[0-9a-f]{6})$/i.test(command.color))
    return { action, id, color: command.color };
  if ((action === "theme" || action === "filter") && typeof command.field === "string" &&
      (command.field === "" || Object.hasOwn(layer.attributes, command.field))) {
    if (action === "theme") return { action, id, field: command.field };
    if (typeof command.text === "string" && command.text.length <= 4096)
      return { action, id, field: command.field, text: command.text };
  }
  if (action === "focus") return { action, id };
  throw new Error("Invalid style command.");
}
async function start() {
  window = new BrowserWindow({
    width: 1250, height: 850, minWidth: 700, minHeight: 500,
    title: "LayerStylingAndFiltering — GeoKernel", backgroundColor: "#090f16",
    icon: path.join(__dirname, "..", "..", "images", "GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("styling:action", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !viewer) return;
    if (action === "reload") { await load(); return; }
    if (action === "cancel") { cancelled = true; viewer.cancel(); return; }
    if (!ready || busy) return;
    if (action === "snapshot") return viewer.layers();
    if (action === "style") { viewer.update(validate(value)); return viewer.layers(); }
    if (action === "imagery" && typeof value === "boolean") {
      settings.imagery = value;
      viewer.imagery(value);
    } else if (action === "height" && Number.isFinite(value) && value >= .25 && value <= 10) {
      settings.height = value;
      viewer.height(value);
    } else if (action === "camera") viewer.reset();
  });
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  await window.loadFile(path.join(__dirname, "index.html"));
  viewer = new LayerStylingViewer(koffi.decode(window.getNativeWindowHandle(), "void *"));
  resize();
  timer = setInterval(() => {
    if (!viewer) return;
    try {
      viewer.pump();
      if (!viewer || !loading) return;
      const result = viewer.poll();
      if (result === 0) return;
      loading = busy = false;
      if (result === 1) {
        ready = true;
        viewer.imagery(settings.imagery);
        viewer.height(settings.height);
        window.webContents.send("styling:loaded", viewer.layers());
        status("Ready — choose a layer to style or filter.");
      } else if (result === -2) status("Loading cancelled.");
      else throw new Error("Loading ended without a scene.");
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
  ipcMain.removeHandler("styling:action");
}
module.exports = { start, stop };
