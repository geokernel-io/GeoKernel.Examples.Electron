"use strict";

// Shared support for the DSM-to-DTM example: pinned sample acquisition (archive and
// every file SHA-256 checked), process-local PROJ/GDAL configuration and Float32
// raster IO through the GDAL runtime shipped with geokernel-electron.
const fs = require("fs");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const koffi = require("koffi");
const AdmZip = require("adm-zip");
const { configureRuntimeEnvironment, findBinDir } = require("geokernel-electron");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SAMPLE_NAMES = ["dsm.tif", "dtm_classical.tif", "dtm_ai.tif", "dtm_reference.tif"];

class Cancelled extends Error {
  constructor() { super("Operation cancelled."); this.name = "Cancelled"; }
}

function checkCancel(token) {
  if (token.cancelled) throw new Cancelled();
}

/** Parse `--sample-archive`, `--sample-url` and `--data-dir` after the example name. */
function parseOptions(argv) {
  const options = { sampleArchive: null, sampleUrl: null, dataDir: null };
  const names = { "--sample-archive": "sampleArchive", "--sample-url": "sampleUrl", "--data-dir": "dataDir" };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key) continue;
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${argv[i]}.`);
    options[key] = argv[++i];
  }
  const base = process.env.GEOKERNEL_EXAMPLES_DATA_DIR ? path.resolve(process.env.GEOKERNEL_EXAMPLES_DATA_DIR) : path.join(PROJECT_ROOT, "outputs", "data");
  options.dataRoot = options.dataDir ? path.resolve(options.dataDir) : base;
  return options;
}

function readAssets() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "sample-assets.json"), "utf8"));
}

function hashFile(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch { return ""; }
}

function validSample(folder, assets) {
  const files = Object.entries(assets.files || {});
  return files.length > 0 && files.every(([name, sha]) => hashFile(path.join(folder, name)) === sha);
}

const SAMPLE_HINT = "The sample ZIP must be uploaded to the SampleData v1 release. Use Retry after upload.";

/** HTTPS download through a `.part` sibling that replaces the destination when complete. */
function download(url, destination, token, progress, redirects = 0, hint = SAMPLE_HINT, label = "Downloading sample data...") {
  if (!url.startsWith("https://")) return Promise.reject(new Error("Download URL must use HTTPS."));
  if (redirects > 5) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "GeoKernel-DsmToDtm-Electron/1.0" }, timeout: 60000 }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, token, progress, redirects + 1, hint, label).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Sample download failed (HTTP ${status}).\n${url}\n${hint}`));
        return;
      }
      const total = Number(response.headers["content-length"] || 0);
      const partial = destination + ".part";
      const file = fs.createWriteStream(partial);
      let done = 0;
      const poll = setInterval(() => { if (token.cancelled) request.destroy(new Cancelled()); }, 50);
      response.on("data", (chunk) => { done += chunk.length; progress(total ? Math.round(100 * done / total) : 0, label); });
      response.pipe(file);
      const fail = (error) => { clearInterval(poll); file.destroy(); fs.rmSync(partial, { force: true }); reject(error); };
      response.on("error", fail);
      file.on("error", fail);
      file.on("finish", () => {
        clearInterval(poll);
        file.close(() => { try { fs.renameSync(partial, destination); resolve(); } catch (error) { reject(error); } });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Sample download timed out.")));
    request.on("error", (error) => reject(error instanceof Cancelled ? error : new Error(`Sample download failed: ${error.message}\n${url}`)));
  });
}

/** Return a verified sample folder; download/extract only when the cache is invalid. */
async function prepareSample(assets, options, token, progress, hint = SAMPLE_HINT) {
  const root = options.dataRoot;
  fs.mkdirSync(root, { recursive: true });
  const folder = path.join(root, assets.cache);
  progress(0, "Checking cached sample files...");
  if (validSample(folder, assets)) return folder;

  const archive = options.sampleArchive ? path.resolve(options.sampleArchive) : path.join(root, assets.archive);
  if (!options.sampleArchive && hashFile(archive) !== assets.sha256)
    await download(options.sampleUrl || assets.url, archive, token, progress, 0, hint);
  checkCancel(token);
  if (hashFile(archive) !== assets.sha256) throw new Error("Sample ZIP SHA-256 mismatch. The existing data was retained.");

  const staging = fs.mkdtempSync(path.join(root, ".extract-"));
  try {
    progress(0, "Extracting verified sample ZIP...");
    const zip = new AdmZip(archive);
    for (const entry of zip.getEntries()) {
      const target = path.resolve(staging, entry.entryName);
      if (!target.startsWith(path.resolve(staging) + path.sep)) throw new Error("Sample ZIP contains an unsafe path.");
    }
    zip.extractAllTo(staging, true);
    checkCancel(token);
    if (!validSample(staging, assets)) throw new Error("Extracted sample files failed SHA-256 verification.");
    if (fs.existsSync(folder)) fs.renameSync(folder, `${folder}.invalid-${Date.now()}`);
    fs.renameSync(staging, folder);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return folder;
}

let gdal = null;

function bindGdal() {
  if (gdal) return gdal;
  const binDir = findBinDir();
  configureRuntimeEnvironment(binDir);
  const library = koffi.load(path.join(binDir, process.platform === "win32" ? "gdal.dll" : "libgdal.so"));
  const bind = (name, result, args) => library.func(name, result, args);
  gdal = {
    binDir,
    register: bind("GDALAllRegister", "void", []),
    open: bind("GDALOpen", "void *", ["str", "int"]),
    close: bind("GDALClose", "void", ["void *"]),
    width: bind("GDALGetRasterXSize", "int", ["void *"]),
    height: bind("GDALGetRasterYSize", "int", ["void *"]),
    band: bind("GDALGetRasterBand", "void *", ["void *", "int"]),
    nodata: bind("GDALGetRasterNoDataValue", "double", ["void *", "void *"]),
    setNodata: bind("GDALSetRasterNoDataValue", "int", ["void *", "double"]),
    io: bind("GDALRasterIO", "int", ["void *", "int", "int", "int", "int", "int", "void *", "int", "int", "int", "int", "int"]),
    getTransform: bind("GDALGetGeoTransform", "int", ["void *", "void *"]),
    setTransform: bind("GDALSetGeoTransform", "int", ["void *", "void *"]),
    getProjection: bind("GDALGetProjectionRef", "str", ["void *"]),
    setProjection: bind("GDALSetProjection", "int", ["void *", "str"]),
    driver: bind("GDALGetDriverByName", "void *", ["str"]),
    create: bind("GDALCreate", "void *", ["void *", "str", "int", "int", "int", "int", "void *"]),
    lastError: bind("CPLGetLastErrorMsg", "str", []),
    newSrs: bind("OSRNewSpatialReference", "void *", ["void *"]),
    destroySrs: bind("OSRDestroySpatialReference", "void", ["void *"]),
    fromEpsg: bind("OSRImportFromEPSG", "int", ["void *", "int"]),
    fromUser: bind("OSRSetFromUserInput", "int", ["void *", "str"]),
    same: bind("OSRIsSame", "int", ["void *", "void *"]),
    projPaths: bind("OSRSetPROJSearchPaths", "void", ["const char **"]),
  };
  gdal.register();
  return gdal;
}

function gdalError(message) {
  const detail = gdal?.lastError() || "";
  return new Error(`${message} ${detail}`.trim());
}

/** Prefer packaged proj-data, then the verified sample PROJ database; process-local only. */
function configureRuntime(sampleFolder) {
  const g = bindGdal();
  const sdkProj = path.join(g.binDir, "proj-data");
  const proj = fs.existsSync(path.join(sdkProj, "proj.db")) ? sdkProj : path.join(sampleFolder, "proj-data");
  if (!fs.existsSync(path.join(proj, "proj.db"))) throw new Error("Sample projection database is missing.");
  process.env.PROJ_DATA = process.env.PROJ_LIB = proj;
  process.env.PROJ_NETWORK = "OFF";
  g.projPaths([proj, null]);
}

function readRaster(file) {
  const g = bindGdal();
  const dataset = g.open(file, 0);
  if (!dataset) throw gdalError(`Cannot open raster ${file}.`);
  try {
    const width = g.width(dataset), height = g.height(dataset);
    if (width < 1 || height < 1 || width * height > 64000000) throw new Error(`Unsupported raster dimensions in ${file}.`);
    const transformBuffer = Buffer.alloc(48);
    if (g.getTransform(dataset, transformBuffer) !== 0) throw new Error(`Raster has no world transform: ${file}.`);
    const transform = Array.from({ length: 6 }, (_, i) => transformBuffer.readDoubleLE(i * 8));
    const band = g.band(dataset, 1);
    const values = new Float32Array(width * height);
    if (g.io(band, 0, 0, 0, width, height, values, width, height, 6, 0, 0) !== 0) throw gdalError(`Could not read numeric values from ${file}.`);
    const has = Buffer.alloc(4);
    const nodata = g.nodata(band, has);
    return { width, height, transform, projection: g.getProjection(dataset) || "", nodata: has.readInt32LE(0) ? nodata : null, values };
  } finally { g.close(dataset); }
}

function sameCrs(projection, epsg) {
  const g = bindGdal();
  const a = g.newSrs(null), b = g.newSrs(null);
  try { return g.fromUser(a, projection) === 0 && g.fromEpsg(b, epsg) === 0 && g.same(a, b) !== 0; }
  finally { g.destroySrs(a); g.destroySrs(b); }
}

function writeFloat(file, width, height, transform, projection, bands, nodata = -9999) {
  const g = bindGdal();
  const dataset = g.create(g.driver("GTiff"), file, width, height, bands.length, 6, null);
  if (!dataset) throw gdalError(`Cannot create GeoTIFF ${file}.`);
  try {
    const transformBuffer = Buffer.alloc(48);
    transform.forEach((value, i) => transformBuffer.writeDoubleLE(value, i * 8));
    if (g.setTransform(dataset, transformBuffer) !== 0 || g.setProjection(dataset, projection) !== 0) throw gdalError("Cannot write GeoTIFF georeferencing.");
    bands.forEach((values, i) => {
      if (values.length !== width * height) throw new Error("GeoTIFF band size mismatch.");
      const band = g.band(dataset, i + 1);
      if (nodata !== null) g.setNodata(band, nodata);
      if (g.io(band, 1, 0, 0, width, height, values, width, height, 6, 0, 0) !== 0) throw gdalError("Cannot write GeoTIFF values.");
    });
  } finally { g.close(dataset); }
  return file;
}

/** Byte RGB GeoTIFF (display only). Byte RGB bypasses the viewer's statistical stretch of
 *  non-Byte imagery, so colours keep their shared, precomputed scale. One array = gray. */
function writeRgb(file, width, height, transform, projection, red, green = red, blue = red) {
  const g = bindGdal();
  const bands = [red, green, blue];
  if (bands.some((band) => band.length !== width * height)) throw new Error("Display image size mismatch.");
  const dataset = g.create(g.driver("GTiff"), file, width, height, 3, 1, null);
  if (!dataset) throw gdalError(`Cannot create GeoTIFF ${file}.`);
  try {
    const transformBuffer = Buffer.alloc(48);
    transform.forEach((value, i) => transformBuffer.writeDoubleLE(value, i * 8));
    if (g.setTransform(dataset, transformBuffer) !== 0 || g.setProjection(dataset, projection) !== 0) throw gdalError("Cannot write GeoTIFF georeferencing.");
    bands.forEach((band, i) => {
      if (g.io(g.band(dataset, i + 1), 1, 0, 0, width, height, band, width, height, 1, 0, 0) !== 0) throw gdalError("Cannot write GeoTIFF values.");
    });
  } finally { g.close(dataset); }
  return file;
}

/** Read and validate the four pinned 500 x 500, 0.5 m EPSG:2056 height rasters. */
function readGrids(folder, token) {
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "source-manifest.json"), "utf8"));
  const profileRow = Number(manifest.profile?.row ?? -1);
  let first = null;
  const z = [];
  for (const name of SAMPLE_NAMES) {
    checkCancel(token);
    const raster = readRaster(path.join(folder, name));
    if (!sameCrs(raster.projection, 2056)) throw new Error("The sample height CRS is not equivalent to EPSG:2056.");
    const t = raster.transform;
    if (raster.width !== 500 || raster.height !== 500 || t[1] !== 0.5 || t[5] !== -0.5 || t[2] !== 0 || t[4] !== 0)
      throw new Error(`The sample requires the pinned 500 x 500, 0.5 m grid. Found ${raster.width} x ${raster.height}; pixel ${t[1]}, ${t[5]}; rotation ${t[4]}, ${t[2]}.`);
    if (!first) first = raster;
    else if (raster.projection !== first.projection || raster.transform.some((v, i) => v !== first.transform[i]))
      throw new Error("Height rasters do not share exactly the same CRS and grid.");
    for (const value of raster.values)
      if (!Number.isFinite(value) || (raster.nodata !== null && value === raster.nodata))
        throw new Error("This prepared comparison requires valid heights in all four rasters.");
    z.push(raster.values);
  }
  if (!(profileRow >= 0 && profileRow < first.height)) throw new Error("Invalid sample profile row.");
  return { folder, width: first.width, height: first.height, transform: first.transform, projection: first.projection, manifest, profileRow, z };
}

/** 0% is exactly the DSM, 100% exactly the selected DTM; between: (1-t)*DSM + t*DTM. */
function blended(grids, method, percent) {
  if (![1, 2].includes(method) || !(percent >= 0 && percent <= 100)) throw new Error("Invalid surface selection.");
  if (percent === 0) return grids.z[0];
  if (percent === 100) return grids.z[method];
  const t = percent / 100, dsm = grids.z[0], dtm = grids.z[method];
  const result = new Float32Array(dsm.length);
  for (let i = 0; i < result.length; i++) result[i] = (1 - t) * dsm[i] + t * dtm[i];
  return result;
}

function surfaceFile(grids, method, percent, temporary) {
  if (percent === 0) return path.join(grids.folder, "dsm.tif");
  if (percent === 100) return path.join(grids.folder, method === 1 ? "dtm_classical.tif" : "dtm_ai.tif");
  return writeFloat(temporary, grids.width, grids.height, grids.transform, grids.projection, [blended(grids, method, percent)]);
}

/** Profile row of each raster as plain arrays for the renderer chart. */
function profile(grids) {
  const start = grids.profileRow * grids.width;
  return grids.z.map((values) => Array.from(values.subarray(start, start + grids.width)));
}

module.exports = { Cancelled, checkCancel, parseOptions, readAssets, hashFile, download, prepareSample, configureRuntime, readRaster, readGrids, surfaceFile, profile, bindGdal, writeFloat, writeRgb };
