"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const koffi = require("koffi");
const { Globe, GlobeInteraction, findBinDir, configureRuntimeEnvironment } = require("geokernel-electron");
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

const home = { longitude: 2.1744, latitude: 41.4036, targetHeightMetres: 40,
  distanceMetres: 2500, pitchDegrees: .85 * 180 / Math.PI, headingDegrees: .6 * 180 / Math.PI };
const instructions = [
  "Line of sight: click observer and target within 10 km. Heights: 1.7 m above ground. Buildings excluded.",
  "Viewshed: click an observer. Radius: 350 m; sample spacing: 15 m. Buildings excluded.",
  "Slope / aspect: click a terrain point to see slope and downhill direction.",
  "Measure: click a start point, then an end point.",
];
let window = null, globe = null, timer = null;
let loaded = false, analyzing = false, mode = -1, points = [];
let result = "Choose an analysis tool, then click the terrain. Drag to navigate; Esc cancels.";
let status = "Loading Barcelona terrain…";

function publish() {
  if (window && !window.isDestroyed())
    window.webContents.send("globe:state", { loaded, mode, result, status });
}

function report(error) {
  status = String(error?.message ?? error);
  publish();
}

function resize() {
  if (!window || !globe) return;
  const [width, height] = window.getContentSize();
  globe.resize(width, Math.max(1, height - 234));
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  if (!positionWindow(globe.nativeHandle(), null, 0, Math.round(40 * scale), 0, 0, 0x0011))
    throw new Error("Cannot position the Globe window.");
}

function clearSelection() {
  analyzing = false;
  points = [];
  mode = -1;
  globe.cancelTerrainAnalysis();
  globe.clearTerrainAnalysis();
  globe.clearMeasurement();
  // ClearInteraction emits selectionFinished; avoid feeding that event back into itself.
  globe.setInteractionMode(GlobeInteraction.Navigate);
  result = "Selection cleared. Choose an analysis tool to select new points.";
}

function showAnalysis() {
  const analysis = globe.getTerrainAnalysis();
  analyzing = analysis.status === "calculating";
  if (analysis.stale) {
    result = "Terrain changed while calculating. Wait for terrain loading to settle, then click to start a new selection. Previous results are no longer current.";
    publish();
    return;
  }
  result = "Status: " + analysis.status;
  if (analysis.slope?.available) {
    const s = analysis.slope;
    result += "\nSlope: " + s.degrees.toFixed(2) + "° (" + s.percent.toFixed(2) + "%)";
    result += "\nAspect: " + (s.aspectDegrees == null ? "Undefined: flat terrain" :
      s.aspectDegrees.toFixed(1) + "° clockwise from north (downhill)");
  } else if (analysis.lineOfSight) {
    const l = analysis.lineOfSight;
    result += "\nLine of sight: " + l.outcome + " | Distance: " + (l.lengthMetres ?? 0).toFixed(1) + " m";
    result += "\nSamples: " + l.processed + "/" + l.total + "; missing: " + l.missingSamples;
    result += "\nThe map line marks the ground path, not the elevated sight ray.";
  } else if (analysis.viewshed) {
    const v = analysis.viewshed;
    result += "\nVisible: " + v.clear + "; blocked: " + v.blocked + "; unknown: " + v.unknown;
    result += "\nProcessed: " + v.processed + "/" + v.total + " | Radius: 350 m";
  } else result += "\nResult unavailable; neighbouring DEM samples may be missing.";
  if (analysis.error) result += "\n" + analysis.error;
  result += "\nTerrain only. Click to start a new selection; Esc cancels.";
  publish();
}

function addPoint(point) {
  const required = mode === 0 || mode === 3 ? 2 : 1;
  if (points.length === required) {
    analyzing = false;
    globe.cancelTerrainAnalysis();
    globe.clearTerrainAnalysis();
    globe.clearMeasurement();
    points = [];
  }
  if (points.length) {
    globe.setMeasurementPoints({ points: [points[0], point] });
    const distance = globe.getMeasurement().distanceMetres;
    if (distance < 1 || (mode === 0 && distance > 10000)) {
      globe.setMeasurementPoints({ points });
      result = distance < 1 ? "Choose a point at least 1 metre away." : "Choose a target within 10 km.";
      publish();
      return;
    }
  }
  points.push(point);
  globe.setMeasurementPoints({ points });
  if (points.length < required)
    result = "Start/observer: " + point.latitude.toFixed(6) + ", " + point.longitude.toFixed(6) + ". Now click the end/target. Esc cancels.";
  else if (mode === 3)
    result = "Ground distance: " + globe.getMeasurement().distanceMetres.toFixed(2) + " m.\nClick to start a new measurement.";
  else {
    globe.startTerrainAnalysis({ mode: ["lineOfSight", "viewshed", "slope"][mode], points,
      spacingMetres: 15, radiusMetres: 350, observerHeightMetres: 1.7, targetHeightMetres: 1.7 });
    analyzing = true;
    showAnalysis();
  }
  publish();
}

async function loadTerrain() {
  const session = globe;
  try {
    const name = "sagrada_familia_terrain";
    const file = await ensureSampleFile(
      "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/" + name + ".zip",
      name + ".zip", name, name + ".tif",
      { onDownloadProgress: percent => report("Downloading terrain… " + (percent ?? "") + "%"),
        onExtracting: () => report("Extracting terrain…") });
    if (session.closed) return;
    const job = session.loadDem({ id: "dem", path: file });
    try { await session.waitJob(job); }
    finally { if (!session.closed) session.forgetJob(job); }
    if (session.closed) return;
    const stats = session.getLayerState("dem").statistics;
    session.setDemStyle(false, stats.minimum, stats.maximum);
    session.options = { ...session.options, terrainEnabled: true, terrainExaggeration: 1 };
    session.camera = home;
    session.setHomeCamera(home);
    loaded = true;
    report("Barcelona | Real DEM | Terrain only | " + session.getAttribution());
    timer = setInterval(() => {
      if (!analyzing) return;
      try { showAnalysis(); }
      catch (error) { analyzing = false; report(error); }
    }, 100);
  } catch (error) { if (!session.closed) report(error); }
}

async function start() {
  loaded = false;
  analyzing = false;
  mode = -1;
  points = [];
  result = "Choose an analysis tool, then click the terrain. Drag to navigate; Esc cancels.";
  status = "Loading Barcelona terrain…";
  window = new BrowserWindow({ width: 1200, height: 800, minWidth: 850, minHeight: 550, show: false,
    title: "GeoKernel — Barcelona Terrain Analysis",
    icon: path.join(__dirname, "../../images/GeoKernelAppIcon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("resize", resize);
  window.on("move", resize);
  window.on("close", stop);
  window.on("closed", () => { window = null; app.quit(); });
  ipcMain.handle("globe:change", (event, key) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !loaded) return;
    try {
      if (Number.isInteger(key) && key >= 0 && key < 4) {
        clearSelection();
        mode = key;
        globe.setInteractionMode(GlobeInteraction.GroundSelection);
        result = instructions[mode];
      } else if (key === "clear") clearSelection();
      else if (key === "home") globe.camera = home;
      publish();
    } catch (error) { report(error); }
  });
  await window.loadFile(path.join(__dirname, "index.html"));
  if (!window) return;
  window.show();
  const handle = window.getNativeWindowHandle();
  const parentWindow = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  globe = new Globe({ parentWindow, autoPump: true, camera: home,
    options: { networkEnabled: true, atmosphereEnabled: true } });
  const esri = globe.getBasemaps().find(item => item.name === "Esri Satellite")?.id ?? -1;
  if (esri < 0) throw new Error("Esri Satellite basemap is unavailable.");
  globe.setBasemap(esri);
  globe.on("nativeError", report);
  globe.on("event", event => {
    if (!loaded) return;
    try {
      if (event.type === "selectionFinished") { clearSelection(); publish(); }
      else if (event.type === "groundClicked" && mode >= 0) {
        if (!event.data.heightAvailable) {
          result = "DEM not loaded here. Wait for terrain or return to Barcelona and try again.";
          publish();
        } else addPoint({ longitude: event.data.longitude, latitude: event.data.latitude });
      }
    } catch (error) { report(error); }
  });
  resize();
  globe.show();
  publish();
  await loadTerrain();
}

function stop() {
  clearInterval(timer);
  timer = null;
  loaded = false;
  analyzing = false;
  ipcMain.removeHandler("globe:change");
  globe?.close();
  globe = null;
}

module.exports = { start, stop };
