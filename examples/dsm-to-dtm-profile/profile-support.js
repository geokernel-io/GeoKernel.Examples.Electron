"use strict";

// Interactive-profile helpers: the shared display relief, bilinear transect samples with
// line-only RMSE/MAE, the fixed example transect and the atomic CSV/metadata export.
const fs = require("fs");
const path = require("path");
const ds = require("../dsm-to-dtm/dsm-support");

const SURFACE_NAMES = ["Original DSM", "Classical DTM", "AI DTM", "Reference DTM"];

/** Hillshade with one fixed light (azimuth 315°, altitude 40°) and contrast for every map.
 *  No per-map normalization: identical heights give identical gray values in every relief. */
function relief(grids, band, token) {
  const w = grids.width, h = grids.height, z = grids.z[band];
  const azimuth = 315 * Math.PI / 180, altitude = 40 * Math.PI / 180;
  const lx = Math.sin(azimuth) * Math.cos(altitude), ly = Math.cos(azimuth) * Math.cos(altitude), lz = Math.sin(altitude);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    ds.checkCancel(token);
    const top = Math.max(0, y - 1), bottom = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const left = Math.max(0, x - 1), right = Math.min(w - 1, x + 1);
      const dx = (z[y * w + right] - z[y * w + left]) / ((right - left) * 0.5);
      const dy = (z[top * w + x] - z[bottom * w + x]) / ((bottom - top) * 0.5);
      const light = (-dx * lx - dy * ly + lz) / Math.sqrt(dx * dx + dy * dy + 1);
      out[y * w + x] = Math.min(255, Math.max(0, Math.floor(255 * (0.25 + 0.75 * Math.max(0, light)) + 0.5)));
    }
  }
  return out;
}

/** Bilinear height between pixel centres; null outside them (no extrapolation). */
function height(grids, band, x, y) {
  const t = grids.transform;
  const col = (x - t[0]) / t[1] - 0.5, row = (y - t[3]) / t[5] - 0.5;
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < -1e-7 || row < -1e-7 || col > grids.width - 1 + 1e-7 || row > grids.height - 1 + 1e-7) return null;
  const cx = Math.min(Math.max(col, 0), grids.width - 1), cy = Math.min(Math.max(row, 0), grids.height - 1);
  const ix = Math.min(Math.floor(cx), grids.width - 2), iy = Math.min(Math.floor(cy), grids.height - 2), w = grids.width;
  const u = cx - ix, v = cy - iy, z = grids.z[band], i = iy * w + ix;
  return (1 - v) * ((1 - u) * z[i] + u * z[i + 1]) + v * ((1 - u) * z[i + w] + u * z[i + w + 1]);
}

/** ceil(length / spacing) + 1 equal-spaced samples (at most 4096). */
function makeProfile(grids, a, b, requested) {
  if (height(grids, 0, a[0], a[1]) === null || height(grids, 0, b[0], b[1]) === null) throw new RangeError("Choose both endpoints inside the raster pixel centres.");
  if (!(Number.isFinite(requested) && requested >= 0.5 && requested <= 10)) throw new RangeError("Profile spacing must be between 0.5 and 10 metres.");
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.5) throw new RangeError("Choose endpoints at least 0.5 m apart.");
  const intervals = Math.min(Math.max(Math.ceil(length / requested), 1), 4095);
  const samples = [], squared = [0, 0], absolute = [0, 0];
  for (let i = 0; i <= intervals; i++) {
    const t = i / intervals, x = a[0] * (1 - t) + b[0] * t, y = a[1] * (1 - t) + b[1] * t;
    const heights = [0, 1, 2, 3].map((band) => height(grids, band, x, y));
    if (heights.includes(null)) throw new RangeError("The transect crosses unavailable raster data.");
    for (let m = 0; m < 2; m++) { const e = heights[m + 1] - heights[3]; squared[m] += e * e; absolute[m] += Math.abs(e); }
    samples.push({ x, y, distance: length * t, heights });
  }
  const n = samples.length;
  return { start: a, end: b, length, spacing: length / intervals, samples, rmse: squared.map((s) => Math.sqrt(s / n)), mae: absolute.map((s) => s / n) };
}

/** The fixed building transect of the first example (row `profile.row`, west half). */
function exampleEndpoints(grids) {
  const t = grids.transform, y = t[3] + (grids.profileRow + 0.5) * t[5];
  return [[t[0] + 0.25, y], [t[0] + (grids.width - 0.5) * 0.5, y]];
}

function atomicWrite(file, text) {
  const temporary = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(temporary, "w");
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
}

/** Write the numeric CSV, then `<name>.csv.metadata.json`; each file atomically. */
function exportProfile(file, profile, grids, archiveSha256) {
  const lines = ["distance_m,easting_epsg2056_m,northing_epsg2056_m,dsm_ln02_m,classical_ln02_m,ai_ln02_m,reference_ln02_m,classical_error_m,ai_error_m"];
  for (const s of profile.samples) {
    const h = s.heights;
    lines.push([s.distance, s.x, s.y, ...h, h[1] - h[3], h[2] - h[3]].map((v) => v.toFixed(6)).join(","));
  }
  atomicWrite(file, lines.join("\n") + "\n");
  const metadata = {
    sample_archive_sha256: archiveSha256, source: grids.manifest,
    sampling: "Bilinear numeric heights, projected metric distances",
    line_length_m: profile.length, sample_spacing_m: profile.spacing, sample_count: profile.samples.length,
    source_attribution: "Federal Office of Topography swisstopo; AI: David Perez, pix_grad adaptation",
  };
  try { atomicWrite(file + ".metadata.json", JSON.stringify(metadata, null, 4)); }
  catch (error) { throw new Error(`CSV saved; cannot save metadata sidecar: ${error.message}`); }
}

module.exports = { SURFACE_NAMES, relief, height, makeProfile, exampleEndpoints, exportProfile };
