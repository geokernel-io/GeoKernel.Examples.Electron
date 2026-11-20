"use strict";

// Reference-accuracy helpers: shared error colours and display maps, evaluation windows of
// native source cells, selected-area metrics and the atomic JSON report.
const fs = require("fs");
const path = require("path");
const ds = require("../dsm-to-dtm/dsm-support");
const ps = require("../dsm-to-dtm-profile/profile-support");

const DISPLAY_LIMITS = [1, 2, 5, 10];
const BIN_EDGES = [0.25, 0.5, 1, 2, 5];
const PRESETS = ["Full sample", "Central urban block", "Northern block", "Southern block", "Custom selection"];

const rgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [v >> 16, (v >> 8) & 0xff, v & 0xff]; };
const NEUTRAL = rgb("#fafafa"), BELOW = rgb("#2464b5"), ABOVE = rgb("#c93645"), ORANGE = rgb("#f4a340"), RED = rgb("#b22f35");
// Round half away from zero, as Qt's lround.
const round = (v) => (v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5));
const mix = (a, b, t) => a.map((x, i) => round(x + (b[i] - x) * t));

/** Shared display scale: signed blue-white-red or absolute white-orange-red, saturating at the limit. */
function errorColor(error, absolute, limit) {
  const t = Math.min(Math.max(Math.abs(error) / limit, 0), 1);
  if (!absolute) return mix(NEUTRAL, error < 0 ? BELOW : ABOVE, t);
  return t < 0.5 ? mix(NEUTRAL, ORANGE, t * 2) : mix(ORANGE, RED, (t - 0.5) * 2);
}

function errorBands(grids, method, absolute, limit, token) {
  const estimate = grids.z[method], reference = grids.z[3], n = reference.length;
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let y = 0; y < grids.height; y++) {
    ds.checkCancel(token);
    for (let i = y * grids.width; i < (y + 1) * grids.width; i++) {
      const c = errorColor(estimate[i] - reference[i], absolute, limit);
      r[i] = c[0]; g[i] = c[1]; b[i] = c[2];
    }
  }
  return [r, g, b];
}

/** Native cells whose centres lie in the area: { left, top, width, height }, clipped to the grid. */
function pixelWindow(grids, [xMin, yMin, xMax, yMax]) {
  if (![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMax <= xMin || yMax <= yMin) throw new RangeError("Choose a nonempty finite study area.");
  const t = grids.transform, dx = t[1], dy = -t[5], x0 = t[0], y0 = t[3];
  const clip = (v, max) => Math.trunc(Math.min(Math.max(v, 0), max));
  const left = clip(Math.ceil((xMin - x0) / dx - 0.5), grids.width);
  const right = clip(Math.floor((xMax - x0) / dx - 0.5) + 1, grids.width);
  const top = clip(Math.ceil((y0 - yMax) / dy - 0.5), grids.height);
  const bottom = clip(Math.floor((y0 - yMin) / dy - 0.5) + 1, grids.height);
  if (right <= left || bottom <= top) throw new RangeError("The selected area contains no source pixel centres.");
  return { left, top, width: right - left, height: bottom - top };
}

/** World bounds of the union of the window's cells. */
function windowExtent(grids, w) {
  const t = grids.transform;
  return [t[0] + w.left * t[1], t[3] + (w.top + w.height) * t[5], t[0] + (w.left + w.width) * t[1], t[3] + w.top * t[5]];
}

/** Geographic windows (not land-cover classes): full, central, northern, southern. */
function presetArea(grids, index) {
  const x = grids.transform[0], y = grids.transform[3], size = grids.width * 0.5;
  return [[x, y - size, x + size, y], [x + size * 0.2, y - size * 0.8, x + size * 0.8, y - size * 0.2],
    [x, y - size * 0.35, x + size, y], [x, y - size, x + size, y - size * 0.65]][index];
}

/** RMSE, MAE, bias, nearest-rank P95 of |error|, count above threshold and six-bin histogram. */
function measure(grids, w, threshold) {
  if (!(Number.isFinite(threshold) && threshold > 0)) throw new RangeError("Error threshold must be positive.");
  if (w.width <= 0 || w.height <= 0 || w.left < 0 || w.top < 0 || w.left + w.width > grids.width || w.top + w.height > grids.height) throw new RangeError("Invalid source pixel window.");
  const reference = grids.z[3];
  return [1, 2].map((method) => {
    const estimate = grids.z[method];
    let squared = 0, absolute = 0, signed = 0, above = 0, n = 0;
    const bins = [0, 0, 0, 0, 0, 0];
    const errors = new Float64Array(w.width * w.height);
    for (let y = w.top; y < w.top + w.height; y++)
      for (let i = y * grids.width + w.left; i < y * grids.width + w.left + w.width; i++) {
        const error = estimate[i] - reference[i], magnitude = Math.abs(error);
        squared += error * error; absolute += magnitude; signed += error;
        if (magnitude > threshold) above++;
        let bin = 0;
        while (bin < BIN_EDGES.length && magnitude > BIN_EDGES[bin]) bin++;
        bins[bin]++;
        errors[n++] = magnitude;
      }
    errors.sort();
    return { count: n, rmse: Math.sqrt(squared / n), mae: absolute / n, bias: signed / n, p95: errors[Math.ceil(0.95 * n) - 1], above, bins };
  });
}

const metricJson = (m) => ({
  pixels: m.count, rmse_m: m.rmse, mae_m: m.mae, bias_m: m.bias, p95_absolute_m: m.p95, above_threshold_pixels: m.above,
  above_threshold_percent: m.count ? (100 * m.above) / m.count : 0, absolute_error_histogram: m.bins,
});

/** Selected-area metrics and provenance as JSON, written atomically. */
function exportReport(file, grids, w, areaName, threshold, metrics, archiveSha256) {
  const report = {
    schema_version: 1, sample_archive_sha256: archiveSha256, source_manifest: grids.manifest, area_name: areaName,
    source_pixel_window: { column: w.left, row: w.top, width: w.width, height: w.height },
    evaluated_cell_bounds_epsg2056: windowExtent(grids, w), pixel_footprint_m2: metrics[0].count * 0.25,
    large_error_threshold_m: threshold, p95_definition: "Nearest-rank empirical 95th percentile of absolute reference errors",
    histogram_bin_edges_m: BIN_EDGES, classical: metricJson(metrics[0]), ai_pix_grad: metricJson(metrics[1]),
    reference_used_for_inference: false,
    metric_scope: "Shared native pixel centres in this selected area; fixed development scene; not held-out generalization accuracy",
    attribution: "Federal Office of Topography swisstopo; AI: David Perez, pix_grad adaptation",
  };
  const temporary = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(report, null, 4));
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
}

/** Nineteen shared-scale Byte RGB maps: DSM relief; per method 4 signed, 4 absolute, 1 relief. */
async function prepareDisplays(grids, folder, token, progress) {
  let done = 0;
  const save = async (bands, name) => {
    ds.checkCancel(token);
    const file = ds.writeRgb(path.join(folder, name), grids.width, grids.height, grids.transform, grids.projection, ...bands);
    progress(Math.floor((++done * 100) / 19));
    await new Promise(setImmediate); // let progress and a cancel request through
    return file;
  };
  const relief = (band) => [ps.relief(grids, band, token)];
  const original = await save(relief(0), "original.tif");
  const methods = [];
  for (const method of [1, 2]) {
    const files = new Array(9);
    for (let k = 0; k < 4; k++) {
      files[k] = await save(errorBands(grids, method, false, DISPLAY_LIMITS[k], token), `signed-${method}-${k}.tif`);
      files[4 + k] = await save(errorBands(grids, method, true, DISPLAY_LIMITS[k], token), `absolute-${method}-${k}.tif`);
    }
    files[8] = await save(relief(method), `terrain-${method}.tif`);
    methods.push(files);
  }
  return { original, methods };
}

module.exports = { DISPLAY_LIMITS, PRESETS, errorColor, pixelWindow, windowExtent, presetArea, measure, exportReport, prepareDisplays };
