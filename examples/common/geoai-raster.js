"use strict";

// Called only by the asset worker. Scientific input is opened read-only and never changed.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const koffi = require("koffi");

async function prepareFloodRgb(asset, check, progress) {
  return prepareRgb(asset, check, progress, false);
}

async function prepareFieldsRgb(asset, check, progress) {
  return prepareRgb(asset, check, progress, true);
}

async function prepareSuperResolutionRgb(asset, check, progress) {
  return prepareRgb(asset, check, progress, true, true);
}

async function prepareRgb(asset, check, progress, fields, superResolution = false) {
  check();
  const base = process.env.GEOKERNEL_EXAMPLES_DATA_DIR || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"), "GeoKernel", "Examples", "GeoAI");
  const root = path.join(base, asset.sha);
  const output = path.join(root, superResolution ? "sen2sr-source-rgb-electron-v1.tif" : fields ? "prue-source-rgb-electron-v1.tif" : "prithvi-source-rgb-electron-v1.tif");
  if (fs.existsSync(output)) return output;
  await fs.promises.mkdir(root, { recursive: true });
  const temporary = path.join(root, crypto.randomUUID() + ".tif");
  try {
    progress(0, fields ? "Preparing first-period RGB display…" : "Preparing source B4/B3/B2 RGB display…");
    createRgb(asset.raster, temporary, asset.binDir, check, fields, superResolution);
    check();
    try { await fs.promises.rename(temporary, output); }
    catch (error) { if (!fs.existsSync(output)) throw error; }
    return output;
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

function createRgb(source, output, binDir, check, fields, superResolution) {
  const { configureRuntimeEnvironment } = require("./geoai-runtime").sdk();
  configureRuntimeEnvironment(binDir);
  const library = koffi.load(path.join(binDir, process.platform === "win32" ? "gdal.dll" : "libgdal.so"));
  const bind = (name, result, args) => library.func(name, result, args);
  const register = bind("GDALAllRegister", "void", []);
  const open = bind("GDALOpen", "void *", ["str", "int"]);
  const close = bind("GDALClose", "void", ["void *"]);
  const widthOf = bind("GDALGetRasterXSize", "int", ["void *"]);
  const heightOf = bind("GDALGetRasterYSize", "int", ["void *"]);
  const countOf = bind("GDALGetRasterCount", "int", ["void *"]);
  const bandOf = bind("GDALGetRasterBand", "void *", ["void *", "int"]);
  const nodataOf = bind("GDALGetRasterNoDataValue", "double", ["void *", "void *"]);
  const io = bind("GDALRasterIO", "int", ["void *", "int", "int", "int", "int", "int", "void *", "int", "int", "int", "int", "int"]);
  const getTransform = bind("GDALGetGeoTransform", "int", ["void *", "void *"]);
  const setTransform = bind("GDALSetGeoTransform", "int", ["void *", "void *"]);
  const getProjection = bind("GDALGetProjectionRef", "str", ["void *"]);
  const setProjection = bind("GDALSetProjection", "int", ["void *", "str"]);
  const driver = bind("GDALGetDriverByName", "void *", ["str"]);
  const create = bind("GDALCreate", "void *", ["void *", "str", "int", "int", "int", "int", "void *"]);
  const setColor = bind("GDALSetRasterColorInterpretation", "int", ["void *", "int"]);
  const checked = value => { if (value !== 0) throw new Error("GDAL could not prepare the RGB source display."); };
  register();
  const input = open(source, 0);
  if (!input) throw new Error("Cannot open the original spectral input.");
  let destination;
  try {
    const width = widthOf(input), height = heightOf(input), count = countOf(input);
    const pixels = width * height;
    if (width < 1 || height < 1 || pixels > 16000000) throw new Error("Unsupported RGB display size.");
    if (superResolution && count !== 4 && count !== 8) throw new Error("SEN2SR needs RGBN input.");
    if (fields && !superResolution && count !== 8) throw new Error("PRUE needs an aligned two-period eight-band stack.");
    if (!fields && count !== 6 && count !== 13) throw new Error("Prithvi needs 13 source bands or six selected spectral bands.");
    const bands = superResolution ? [1, 2, 3, 4] : fields ? [1, 2, 3, 4, 5, 6, 7, 8] : count === 13 ? [2, 3, 4, 9, 12, 13] : [1, 2, 3, 4, 5, 6];
    const valid = new Uint8Array(pixels).fill(1);
    const channels = [];
    for (let index = 0; index < bands.length; index++) {
      check();
      const band = bandOf(input, bands[index]);
      const buffer = Buffer.alloc(pixels * 4);
      checked(io(band, 0, 0, 0, width, height, buffer, width, height, 6, 0, 0));
      const hasNodata = Buffer.alloc(4);
      const nodata = nodataOf(band, hasNodata);
      const declared = hasNodata.readInt32LE(0) !== 0;
      const values = new Float32Array(pixels);
      for (let i = 0; i < pixels; i++) {
        const value = buffer.readFloatLE(i * 4);
        values[i] = value;
        valid[i] &= Number.isFinite(value) && value >= 0 && (!declared || value !== nodata);
      }
      if (index < 3) channels[fields ? index : 2 - index] = values;
    }
    const transform = Buffer.alloc(48);
    checked(getTransform(input, transform));
    destination = create(driver("GTiff"), output, width, height, 4, 1, null);
    if (!destination) throw new Error("Cannot create the RGB source display.");
    checked(setTransform(destination, transform));
    checked(setProjection(destination, getProjection(input)));
    for (let channel = 0; channel < 4; channel++) {
      check();
      const buffer = Buffer.alloc(pixels);
      if (channel === 3) {
        for (let i = 0; i < pixels; i++) buffer[i] = valid[i] ? 255 : 0;
      } else {
        const values = channels[channel];
        const ordered = Array.from(values).filter((_, i) => valid[i]).sort((a, b) => a - b);
        if (!ordered.length) throw new Error("No valid pixels in the spectral source.");
        const low = ordered[Math.floor((ordered.length - 1) * 0.02)];
        const high = ordered[Math.floor((ordered.length - 1) * 0.98)];
        const scale = 255 / Math.max(high - low, 1);
        for (let i = 0; i < pixels; i++) if (valid[i]) buffer[i] = Math.trunc(Math.max(0, Math.min(255, (values[i] - low) * scale)));
      }
      const band = bandOf(destination, channel + 1);
      checked(io(band, 1, 0, 0, width, height, buffer, width, height, 1, 0, 0));
      checked(setColor(band, channel + 3));
    }
  } finally {
    if (destination) close(destination);
    close(input);
  }
}

module.exports = { prepareFloodRgb, prepareFieldsRgb, prepareSuperResolutionRgb };
