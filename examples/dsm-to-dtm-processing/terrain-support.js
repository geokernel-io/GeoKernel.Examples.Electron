"use strict";

// Live classical DSM-to-DTM processing (method native-multiscale-morphological-tin-v1), a port of
// the Qt DsmToDtmProcessing filter: block lower envelope keeping each minimum's real source pixel,
// reflected-boundary morphological openings at increasing scales with a slope/relief/roughness
// allowance, GDAL linear TIN gridding at the native pixel centres, retained source samples, a DSM
// upper bound and QA bits. Grids are Float32Array and float operations of the C++ code are rounded
// with Math.fround, so results match the Qt build. The reference is never an input to estimate().
// Long loops yield to the event loop (Electron's main thread also pumps the native maps).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const koffi = require("koffi");
const ds = require("../dsm-to-dtm/dsm-support");

const NODATA = -9999;
const METHOD = "native-multiscale-morphological-tin-v1";
const f = Math.fround;
const PRESETS = [
  { working: 2, window: 64, threshold: 0.4, slope: 0.12, terrain: 0.5, retain: 0.35 },
  { working: 1, window: 80, threshold: 0.25, slope: 0.08, terrain: 0.25, retain: 0.2 },
  { working: 2, window: 48, threshold: 0.6, slope: 0.16, terrain: 0.8, retain: 0.4 },
];
const PRESET_NAMES = ["Balanced", "Remove more objects", "Preserve more relief"];

// ----- GDAL bridge (the SDK-deployed gdal.dll) ----------------------------------------------------
let bridge = null;
function gdal() {
  if (bridge) return bridge;
  const g = ds.bindGdal();
  const library = koffi.load(path.join(g.binDir, process.platform === "win32" ? "gdal.dll" : "libgdal.so"));
  const bind = (name, result, args) => library.func(name, result, args);
  const LinearOptions = koffi.struct("GeoKernelGridLinearOptions", { size: "size_t", radius: "double", nodata: "double" });
  const GridProgress = koffi.proto("int GeoKernelGridProgress(double, const char *, void *)");
  bridge = {
    g, LinearOptions, GridProgress,
    version: bind("GDALVersionInfo", "str", ["str"]),
    count: bind("GDALGetRasterCount", "int", ["void *"]),
    mask: bind("GDALGetMaskBand", "void *", ["void *"]),
    scale: bind("GDALGetRasterScale", "double", ["void *", "void *"]),
    offset: bind("GDALGetRasterOffset", "double", ["void *", "void *"]),
    units: bind("GDALGetRasterUnitType", "str", ["void *"]),
    setUnits: bind("GDALSetRasterUnitType", "int", ["void *", "str"]),
    setMetadata: bind("GDALSetMetadataItem", "int", ["void *", "str", "str", "str"]),
    create: bind("GDALCreate", "void *", ["void *", "str", "int", "int", "int", "int", "const char **"]),
    isProjected: bind("OSRIsProjected", "int", ["void *"]),
    linearUnits: bind("OSRGetLinearUnits", "double", ["void *", "void *"]),
    gridCreate: bind("GDALGridContextCreate", "void *", ["int", koffi.pointer(LinearOptions), "uint", "void *", "void *", "void *", "int"]),
    gridProcess: bind("GDALGridContextProcess", "int", ["void *", "double", "double", "double", "double", "uint", "uint", "int", "void *", koffi.pointer(GridProgress), "void *"]),
    gridFree: bind("GDALGridContextFree", "void", ["void *"]),
  };
  if (!(Number(bridge.version("VERSION_NUM")) >= 3060000)) throw new Error("The gridding bridge requires GDAL 3.6 or newer.");
  return bridge;
}

const require_ = (condition, message) => { if (!condition) throw new Error(message); };
function gdalError(message) { return new Error(`${message} ${gdal().g.lastError() || ""}`.trim()); }

/** Yield to the event loop at most every ~25 ms, then honour cancellation. */
function scheduler(token) {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < 25) return;
    await new Promise(setImmediate);
    last = Date.now();
    ds.checkCancel(token);
  };
}

function metreProjected(projection) {
  const b = gdal(), g = b.g;
  const srs = g.newSrs(null);
  try {
    if (g.fromUser(srs, projection) !== 0 || !b.isProjected(srs)) return false;
    return Math.abs(b.linearUnits(srs, Buffer.alloc(8)) - 1) < 1e-9;
  } finally { g.destroySrs(srs); }
}

/** Single-band north-up metre heights in a projected metre CRS, with an explicit validity mask. */
function readRaster(file, token) {
  ds.checkCancel(token);
  const b = gdal(), g = b.g;
  const dataset = g.open(file, 0);
  if (!dataset) throw gdalError("Cannot open height raster.");
  let width, height, transform, projection, z, mask, nodata, hasNodata;
  try {
    require_(b.count(dataset) === 1, "Use a single-band height raster.");
    const band = g.band(dataset, 1), present = Buffer.alloc(4);
    const scale = b.scale(band, present);
    require_(!present.readInt32LE(0) || Math.abs(scale - 1) < 1e-12, "Apply raster scale to metre heights before opening.");
    const offset = b.offset(band, present);
    require_(!present.readInt32LE(0) || Math.abs(offset) < 1e-12, "Apply raster offset before opening.");
    const units = (b.units(band) || "").toLowerCase();
    require_(["", "m", "metre", "meter", "metres", "meters"].includes(units), "Height units must be metres. Unspecified units are assumed to be metres.");
    width = g.width(dataset); height = g.height(dataset);
    const buffer = Buffer.alloc(48);
    const hasTransform = g.getTransform(dataset, buffer) === 0;
    const t = Array.from({ length: 6 }, (_, i) => buffer.readDoubleLE(i * 8));
    projection = g.getProjection(dataset) || "";
    require_(metreProjected(projection), "Use a projected CRS with metre XY units.");
    require_(hasTransform && t[2] === 0 && t[4] === 0 && t[1] > 0 && Math.abs(t[1] + t[5]) < 1e-9, "Use a north-up raster with square pixels.");
    require_(width >= 8 && height >= 8 && width * height <= 4000000, "This interactive example supports 8 x 8 to 4 million source cells.");
    transform = [t[0], t[1], 0, t[3], 0, t[5]];
    z = new Float32Array(width * height);
    if (g.io(band, 0, 0, 0, width, height, z, width, height, 6, 0, 0) !== 0) throw gdalError("Cannot read complete heights.");
    const has = Buffer.alloc(4);
    nodata = g.nodata(band, has);
    hasNodata = has.readInt32LE(0) !== 0;
    mask = new Uint8Array(width * height);
    if (g.io(b.mask(band), 0, 0, 0, width, height, mask, width, height, 1, 0, 0) !== 0) throw gdalError("Cannot read source validity pixels.");
  } finally { g.close(dataset); }
  const valid = new Uint8Array(z.length);
  let count = 0;
  for (let i = 0; i < z.length; i++) {
    if (mask[i] && Number.isFinite(z[i]) && (!hasNodata || z[i] !== nodata)) { valid[i] = 1; count++; }
  }
  require_(count >= 4 && count >= z.length * 0.05, "Insufficient valid source coverage.");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return { path: path.resolve(file), projection, sha256, width, height, pixel: transform[1], transform, z, valid };
}

function extent(raster) {
  const t = raster.transform;
  return [t[0], t[3] - raster.height * raster.pixel, t[0] + raster.width * raster.pixel, t[3]];
}

function validateReference(dsm, reference) {
  const g = gdal().g;
  const a = g.newSrs(null), b = g.newSrs(null);
  let same;
  try { same = g.fromUser(a, dsm.projection) === 0 && g.fromUser(b, reference.projection) === 0 && g.same(a, b) !== 0; }
  finally { g.destroySrs(a); g.destroySrs(b); }
  require_(same && dsm.width === reference.width && dsm.height === reference.height && dsm.transform.every((v, i) => v === reference.transform[i]),
    "Reference must share the DSM's exact dimensions, grid and equivalent CRS; no implicit resampling.");
}

/** Float32 heights (type 6, NoData -9999, metre units) or Byte QA (type 1, NoData 1) on the source grid. */
function writeRaster(raster, file, data, type) {
  const b = gdal(), g = b.g;
  const dataset = b.create(g.driver("GTiff"), file, raster.width, raster.height, 1, type, ["COMPRESS=DEFLATE", "TILED=YES", null]);
  if (!dataset) throw gdalError(`Cannot create GeoTIFF: ${file}`);
  try {
    const buffer = Buffer.alloc(48);
    raster.transform.forEach((v, i) => buffer.writeDoubleLE(v, i * 8));
    if (g.setTransform(dataset, buffer) !== 0 || g.setProjection(dataset, raster.projection) !== 0) throw gdalError("Cannot write raster coordinates.");
    b.setMetadata(dataset, "GEOKERNEL_TERRAIN_METHOD", METHOD, null);
    const band = g.band(dataset, 1);
    g.setNodata(band, type === 1 ? 1 : NODATA);
    if (type === 6) b.setUnits(band, "metre");
    if (g.io(band, 1, 0, 0, raster.width, raster.height, data, raster.width, raster.height, type, 0, 0) !== 0) throw gdalError("Cannot write raster pixels.");
  } finally { g.close(dataset); }
  return file;
}

// ----- filter building blocks ---------------------------------------------------------------------
function reflect(index, count) {
  while (index < 0 || index >= count) index = index < 0 ? -index - 1 : 2 * count - index - 1;
  return index;
}

/** Separable sliding minimum/maximum over (2r+1)² with reflected boundaries (monotonic deque). */
async function extremes(input, width, height, radius, minimum, tick) {
  const horizontal = new Float32Array(input.length), output = new Float32Array(input.length);
  const capacity = Math.max(width, height) + 2 * radius + 1;
  const keys = new Int32Array(capacity), values = new Float32Array(capacity);
  const pass = async (source, target, vertical) => {
    const lines = vertical ? width : height, length = vertical ? height : width;
    for (let line = 0; line < lines; line++) {
      await tick();
      let head = 0, tail = 0;
      for (let k = -radius; k < length + radius; k++) {
        const at = reflect(k, length);
        const value = source[vertical ? at * width + line : line * width + at];
        while (tail > head && (minimum ? values[tail - 1] >= value : values[tail - 1] <= value)) tail--;
        keys[tail] = k;
        values[tail++] = value;
        while (keys[head] < k - radius * 2) head++;
        const destination = k - radius;
        if (destination >= 0) target[vertical ? destination * width + line : line * width + destination] = values[head];
      }
    }
  };
  await pass(input, horizontal, false);
  await pass(horizontal, output, true);
  return output;
}

async function gaussian(input, width, height, sigma, tick) {
  const radius = Math.ceil(3 * sigma), kernel = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) sum += kernel[k + radius] = Math.exp(-0.5 * k * k / (sigma * sigma));
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  const temporary = new Float32Array(input.length), output = new Float32Array(input.length);
  for (let y = 0; y < height; y++) {
    await tick();
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) value += input[y * width + reflect(x + k, width)] * kernel[k + radius];
      temporary[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    await tick();
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) value += temporary[reflect(y + k, height) * width + x] * kernel[k + radius];
      output[y * width + x] = value;
    }
  }
  return output;
}

function gradient(z, width, height, pixel) {
  const result = new Float32Array(z.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = Math.max(0, x - 1), r = Math.min(width - 1, x + 1), t = Math.max(0, y - 1), b = Math.min(height - 1, y + 1);
      // Float32 height differences as in the C++ code, then double slopes.
      const dx = f(z[y * width + r] - z[y * width + l]) / ((r - l) * pixel), dy = f(z[b * width + x] - z[t * width + x]) / ((b - t) * pixel);
      result[y * width + x] = Math.hypot(dx, dy);
    }
  }
  return result;
}

/** Four-neighbour propagation of the nearest support index (fills holes and hull fallbacks). */
async function supportMap(valid, width, height, tick) {
  const nearest = new Int32Array(valid.length).fill(-1), queue = new Int32Array(valid.length);
  let tail = 0;
  for (let i = 0; i < valid.length; i++) if (valid[i]) { nearest[i] = i; queue[tail++] = i; }
  require_(tail > 0, "No support cells.");
  for (let head = 0; head < tail; head++) {
    if (head % 4096 === 0) await tick();
    const i = queue[head], x = i % width, y = (i / width) | 0;
    for (const n of [x ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y ? i - width : -1, y + 1 < height ? i + width : -1]) {
      if (n >= 0 && nearest[n] < 0) { nearest[n] = nearest[i]; queue[tail++] = n; }
    }
  }
  return nearest;
}

function triangulate(raster, x, y, z, token, progress) {
  const b = gdal();
  ds.checkCancel(token);
  progress(62, `Triangulating ${z.length} ground supports...`);
  const options = { size: koffi.sizeof(b.LinearOptions), radius: 0, nodata: NODATA };
  const context = b.gridCreate(10, options, z.length, x, y, z, 1);
  ds.checkCancel(token);
  if (!context) throw new Error("GDAL could not triangulate ground supports; check candidate distribution and SDK Qhull support.");
  const result = new Float32Array(raster.width * raster.height).fill(NODATA);
  const callback = koffi.register((fraction) => {
    progress(65 + Math.trunc(fraction * 16), "Interpolating native source pixel centres...");
    return token.cancelled ? 0 : 1;
  }, koffi.pointer(b.GridProgress));
  let status;
  try {
    // Local x = column metres, y = row metres; output GeoTIFFs keep the real CRS.
    status = b.gridProcess(context, 0, raster.width * raster.pixel, 0, raster.height * raster.pixel, raster.width, raster.height, 6, result, callback, null);
  } finally {
    koffi.unregister(callback);
    b.gridFree(context);
  }
  ds.checkCancel(token);
  if (status !== 0) throw new Error("TIN interpolation failed.");
  return result;
}

async function estimate(dsm, p, token, progress) {
  const started = Date.now();
  const tick = scheduler(token);
  const factor = Math.max(1, Math.round(p.working / dsm.pixel));
  const working = factor * dsm.pixel;
  require_(p.window >= 2 * working, "Maximum window must span at least two working cells.");
  const width = Math.trunc((dsm.width + factor - 1) / factor), height = Math.trunc((dsm.height + factor - 1) / factor);
  require_(width >= 3 && height >= 3 && width * height <= 262144, "Working grid must have at least 3 x 3 and at most 262144 cells. Adjust working resolution.");
  const count = width * height;
  const low = new Float32Array(count).fill(Infinity), minima = new Int32Array(count).fill(-1), valid = new Uint8Array(count);
  const z = dsm.z, sv = dsm.valid, sw = dsm.width;
  for (let y = 0; y < dsm.height; y++) {
    await tick();
    const row = Math.trunc(y / factor) * width;
    for (let x = 0; x < sw; x++) {
      const source = y * sw + x, cell = row + Math.trunc(x / factor);
      if (sv[source] && z[source] < low[cell]) { low[cell] = z[source]; minima[cell] = source; valid[cell] = 1; }
    }
  }
  const fill = await supportMap(valid, width, height, tick);
  for (let i = 0; i < count; i++) if (!valid[i]) low[i] = low[fill[i]];
  const candidates = valid.slice();
  const radiusFor = (window) => Math.max(1, Math.trunc(Math.round(window / working) / 2));
  const opening = async (values, radius) => extremes(await extremes(values, width, height, radius, true, tick), width, height, radius, false, tick);

  progress(15, "Estimating DSM-derived slope and roughness...");
  const envelope = await opening(low, radiusFor(p.window));
  const terrainSlope = await gaussian(gradient(envelope, width, height, working), width, height, 1, tick);
  const smoothed = await gaussian(low, width, height, 1, tick);
  const localSlope = await extremes(gradient(smoothed, width, height, working), width, height, 2, false, tick);
  const highPass = new Float32Array(count);
  for (let i = 0; i < count; i++) { const d = f(low[i] - smoothed[i]); highPass[i] = d * d; }
  const variance = await gaussian(highPass, width, height, 2, tick);
  const weights = new Float64Array(count);
  for (let i = 0; i < count; i++) weights[i] = 1 / (1 + Math.pow(f(Math.sqrt(Math.max(0, variance[i]))) / 0.6, 4));
  const windows = [];
  for (let window = Math.max(working * 2, 4); window < p.window; window *= 2) windows.push(window);
  windows.push(p.window);
  for (let step = 0; step < windows.length; step++) {
    const window = windows[step];
    progress(20 + Math.trunc(35 * step / windows.length), `Ground candidates: ${window} m window`);
    const opened = await opening(low, radiusFor(window));
    const slope = await extremes(terrainSlope, width, height, radiusFor(window), false, tick);
    const base = Math.min(3, p.threshold + p.slope * window);
    for (let i = 0; i < count; i++) {
      const threshold = base + p.terrain * window * Math.min(slope[i], localSlope[i]) * weights[i];
      candidates[i] = candidates[i] && f(low[i] - opened[i]) <= threshold ? 1 : 0;
    }
  }
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < count; i++) {
    if (!candidates[i]) continue;
    const source = minima[i];
    xs.push((source % sw + 0.5) * dsm.pixel);
    ys.push((Math.trunc(source / sw) + 0.5) * dsm.pixel);
    zs.push(z[source]);
  }
  require_(zs.length >= 4, "Not enough ground supports; relax parameters.");
  const nearest = await supportMap(candidates, width, height, tick);
  await new Promise(setImmediate);
  const dtm = triangulate(dsm, Float64Array.from(xs), Float64Array.from(ys), Float64Array.from(zs), token, progress);
  const n = z.length, removed = new Float32Array(n), quality = new Uint8Array(n);
  let retained = 0, fallback = 0, clamped = 0, borderCount = 0;
  const border = Math.ceil(p.window * 0.5 / dsm.pixel);
  for (let row = 0; row < dsm.height; row++) {
    await tick();
    const cellRow = Math.trunc(row / factor) * width, edgeRow = row < border || row >= dsm.height - border;
    for (let col = 0; col < sw; col++) {
      const i = row * sw + col;
      if (!sv[i]) { dtm[i] = removed[i] = NODATA; quality[i] = 1; continue; }
      const cell = cellRow + Math.trunc(col / factor);
      let qa = 0;
      if (dtm[i] === NODATA || !Number.isFinite(dtm[i])) { dtm[i] = low[nearest[cell]]; qa |= 4; fallback++; }
      if (candidates[cell] && Math.abs(f(z[i] - dtm[i])) <= p.retain) { dtm[i] = z[i]; retained++; } else qa |= 2;
      if (dtm[i] > z[i]) { dtm[i] = z[i]; qa |= 16; clamped++; }
      if (edgeRow || col < border || col >= sw - border) { qa |= 8; borderCount++; }
      removed[i] = Math.max(0, f(z[i] - dtm[i]));
      quality[i] = qa;
    }
  }
  const seconds = (Date.now() - started) / 1000;
  const summary = {
    method: METHOD, effective_working_m: working, support_points: zs.length, retained_source_pixels: retained,
    outside_hull_fallback_pixels: fallback, upper_bound_clamped_pixels: clamped, edge_sensitive_pixels: borderCount,
    edge_band_m: p.window * 0.5, compute_seconds: seconds,
  };
  progress(84, "Preparing numeric GeoTIFFs and display maps...");
  return { parameters: { ...p }, working, seconds, supports: zs.length, dtm, removed, quality, summary };
}

// ----- displays, scores and report -----------------------------------------------------------------
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const GRAY = rgb("#75818c"), WHITE = rgb("#fafafa"), REMOVED = rgb("#bc3e31"), BELOW = rgb("#2464b5"), ABOVE = rgb("#c93645");
const QA = { fallback: rgb("#a743a6"), edge: rgb("#e8ad49"), interpolated: rgb("#edf3f5"), retained: rgb("#15969b") };

function blend(a, b, t) {
  t = Math.min(Math.max(t, 0), 1);
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
}

/** Hillshade (azimuth 315°, altitude 40°) on true pixel spacing; NoData gray. */
async function relief(raster, z, token) {
  const tick = scheduler(token);
  const w = raster.width, h = raster.height, valid = raster.valid, n = w * h;
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  const az = 315 * 3.141592653589793 / 180, alt = 40 * 3.141592653589793 / 180;
  const lx = Math.sin(az) * Math.cos(alt), ly = Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);
  for (let y = 0; y < h; y++) {
    await tick();
    const t = Math.max(0, y - 1), bt = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) { [r[i], g[i], b[i]] = GRAY; continue; }
      const here = z[i], at = (xx, yy) => { const k = yy * w + xx; return valid[k] ? z[k] : here; };
      const l = Math.max(0, x - 1), rr = Math.min(w - 1, x + 1);
      const dx = f(at(rr, y) - at(l, y)) / ((rr - l) * raster.pixel), dy = f(at(x, t) - at(x, bt)) / ((bt - t) * raster.pixel);
      const light = (-dx * lx - dy * ly + lz) / Math.sqrt(dx * dx + dy * dy + 1);
      r[i] = g[i] = b[i] = Math.min(255, Math.max(0, Math.round(255 * (0.25 + 0.75 * Math.max(0, light)))));
    }
  }
  return [r, g, b];
}

/** 0 removed height (0-20 m), 1 support/edge quality, 2 signed reference error (-2..+2 m). */
async function diagnostic(dsm, terrain, mode, reference, token) {
  const tick = scheduler(token);
  const n = dsm.width * dsm.height, r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let y = 0; y < dsm.height; y++) {
    await tick();
    for (let i = y * dsm.width; i < (y + 1) * dsm.width; i++) {
      let color = GRAY;
      if (dsm.valid[i]) {
        if (mode === 0) color = blend(WHITE, REMOVED, terrain.removed[i] / 20);
        else if (mode === 1) {
          const qa = terrain.quality[i];
          color = qa & 4 ? QA.fallback : qa & 8 ? QA.edge : qa & 2 ? QA.interpolated : QA.retained;
        } else if (reference && reference.valid[i]) {
          const error = terrain.dtm[i] - reference.z[i];
          color = error < 0 ? blend(WHITE, BELOW, -error / 2) : blend(WHITE, ABOVE, error / 2);
        }
      }
      [r[i], g[i], b[i]] = color;
    }
  }
  return [r, g, b];
}

function score(dsm, result, reference, border = 0) {
  const s = { count: 0, rmse: 0, mae: 0, bias: 0 };
  if (!reference) return s;
  let squared = 0, absolute = 0, signed = 0;
  for (let y = border; y < dsm.height - border; y++) {
    for (let x = border; x < dsm.width - border; x++) {
      const i = y * dsm.width + x;
      if (!dsm.valid[i] || !reference.valid[i]) continue;
      const e = result[i] - reference.z[i];
      s.count++; squared += e * e; absolute += Math.abs(e); signed += e;
    }
  }
  if (s.count) { s.rmse = Math.sqrt(squared / s.count); s.mae = absolute / s.count; s.bias = signed / s.count; }
  return s;
}

const scoreJson = (s) => ({ pixels: s.count, rmse_m: s.count ? s.rmse : null, mae_m: s.count ? s.mae : null, bias_m: s.count ? s.bias : null });
const parametersJson = (p) => ({
  requested_working_m: p.working, maximum_window_m: p.window, base_threshold_m: p.threshold, slope_allowance: p.slope,
  terrain_slope_factor: p.terrain, retain_tolerance_m: p.retain, roughness_scale_m: 0.6, maximum_base_threshold_m: 3,
});

/** Scores over all shared valid cells and outside the edge band (half the maximum window). */
function evaluate(dsm, terrain, reference) {
  return { all: score(dsm, terrain.dtm, reference), interior: score(dsm, terrain.dtm, reference, Math.ceil(terrain.parameters.window * 0.5 / dsm.pixel)) };
}

function report(dsm, reference, manifest, terrain, all, interior) {
  return {
    schema_version: 1,
    method: METHOD,
    parameters: parametersJson(terrain.parameters),
    summary: terrain.summary,
    source_dsm: dsm.path,
    source_sha256: dsm.sha256,
    reference: reference ? reference.path : null,
    reference_sha256: reference ? reference.sha256 : null,
    reference_used_for_processing: false,
    grid: { width: dsm.width, height: dsm.height, geotransform: dsm.transform, crs_wkt: dsm.projection },
    source_manifest: manifest,
    all_valid_reference_error: scoreJson(all),
    interior_reference_error: scoreJson(interior),
    edge_band_definition: "Half the requested maximum window, rounded up to source cells",
    quality_bits: {
      1: "Source NoData", 2: "Interpolated (not explicitly retained source sample)", 4: "Outside TIN hull: grid-support fallback",
      8: "Edge-sensitive band", 16: "Prediction clamped to DSM",
    },
    height_units: "metre; unspecified source units assumed metres; no vertical datum conversion",
    processing_scope: "This input raster only. Supply surrounding DSM context and crop afterward to reduce boundary effects.",
  };
}

/** Copy through a temporary sibling, flushed to disk, then replace the target. */
function atomicCopy(source, target, token) {
  const temporary = path.join(path.dirname(path.resolve(target)), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    ds.checkCancel(token);
    const data = fs.readFileSync(source), descriptor = fs.openSync(temporary, "w");
    try { fs.writeSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    ds.checkCancel(token);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 4)); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
}

const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

module.exports = {
  NODATA, METHOD, PRESETS, PRESET_NAMES, readRaster, extent, validateReference, writeRaster, estimate, relief, diagnostic,
  score, scoreJson, parametersJson, supportMap, scheduler, evaluate, report, atomicCopy, writeJson, sameFile,
};
