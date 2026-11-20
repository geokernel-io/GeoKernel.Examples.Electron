"use strict";

// DSM + orthophoto to DTM support: three independent terrain estimates from the same full DSM: the
// classical filter (DSM only), pix_grad (DSM only) and rgb_grad_fm (DSM, R, G, B). Both models run
// through GeoKernel.AI's raster inference C ABI as asynchronous koffi calls (see ../dsm-to-dtm-ai).
// No method sees another's result or the evaluation reference.
const fs = require("fs");
const path = require("path");
const koffi = require("koffi");
const ds = require("../dsm-to-dtm/dsm-support");
const tr = require("../dsm-to-dtm-processing/terrain-support");
const ai = require("../dsm-to-dtm-ai/ai-support");

const METHODS = ["classical", "pix_grad", "rgb_grad_fm"];
const MODEL_IDS = ["davpergan-dtm-dsm-gan-pix-grad", "davpergan-dtm-dsm-gan-rgb-grad-fm"];
const MODEL_SHA256 = ["e400e27f6afc75bcf4e1a61432ee9557529683903996dd953d3e8e3fcbe90eb6", "5042d5abac64d6b1764265924c9910807e3a5efee7e1b9517fc9d86bf4d0e3a3"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sampleAssets = () => readJson(path.join(__dirname, "sample-assets.json"));
const modelAssets = (index) => readJson(path.join(__dirname, index ? "rgb-model-assets.json" : "pix-model-assets.json"));

/** `--data-dir`, `--sample-archive`/`--sample-url` and `--pix|rgb-model-archive`/`--pix|rgb-model-url`. */
function parseOptions(argv) {
  const options = ds.parseOptions(argv);
  options.modelArchives = [null, null];
  options.modelUrls = [null, null];
  const names = { "--pix-model-archive": ["modelArchives", 0], "--rgb-model-archive": ["modelArchives", 1], "--pix-model-url": ["modelUrls", 0], "--rgb-model-url": ["modelUrls", 1] };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key) continue;
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${argv[i]}.`);
    options[key[0]][key[1]] = argv[++i];
  }
  return options;
}

/** Verified pix_grad (0) or rgb_grad_fm (1) package folder. */
function prepareModel(options, index, archive, token, progress) {
  return ai.preparePackage(modelAssets(index), options.dataRoot, archive || options.modelArchives[index], options.modelUrls[index], MODEL_IDS[index],
    MODEL_SHA256[index], token, (percent, message) => progress(percent, `${METHODS[index + 1]}: ${message}`));
}

// ----- orthophoto ------------------------------------------------------------------------------------
let bridge = null;
function gdal() {
  if (bridge) return bridge;
  const library = koffi.load(path.join(ds.bindGdal().binDir, process.platform === "win32" ? "gdal.dll" : "libgdal.so"));
  const bind = (name, result, args) => library.func(name, result, args);
  bridge = {
    count: bind("GDALGetRasterCount", "int", ["void *"]),
    type: bind("GDALGetRasterDataType", "int", ["void *"]),
    color: bind("GDALGetRasterColorInterpretation", "int", ["void *"]),
    scale: bind("GDALGetRasterScale", "double", ["void *", "void *"]),
    offset: bind("GDALGetRasterOffset", "double", ["void *", "void *"]),
    mask: bind("GDALGetMaskBand", "void *", ["void *"]),
  };
  return bridge;
}

/** Three RGB-ordered Byte bands on the DSM's exact grid that cover every valid DSM cell. */
async function readOrtho(dsm, file, token) {
  ds.checkCancel(token);
  const g = ds.bindGdal(), b = gdal(), n = dsm.width * dsm.height;
  const dataset = g.open(file, 0);
  if (!dataset) throw new Error("Cannot open RGB orthophoto.");
  const bands = [], valid = new Uint8Array(n).fill(1);
  try {
    if (b.count(dataset) !== 3) throw new Error("Orthophoto must contain exactly three RGB Byte bands.");
    const buffer = Buffer.alloc(48);
    const hasTransform = g.getTransform(dataset, buffer) === 0;
    const t = Array.from({ length: 6 }, (_, i) => buffer.readDoubleLE(i * 8));
    if (!(ai.sameCrs(dsm.projection, g.getProjection(dataset) || "") && hasTransform && g.width(dataset) === dsm.width && g.height(dataset) === dsm.height
          && t.every((v, i) => v === dsm.transform[i])))
      throw new Error("RGB and DSM must have the same dimensions, exact affine grid and equivalent CRS. Align them before loading.");
    const mask = new Uint8Array(n), present = Buffer.alloc(4);
    for (let channel = 0; channel < 3; channel++) {
      ds.checkCancel(token);
      const band = g.band(dataset, channel + 1);
      if (b.type(band) !== 1 || b.color(band) !== channel + 3) throw new Error("Use RGB-ordered Byte bands; no implicit spectral or color conversion is performed.");
      const scale = b.scale(band, present);
      if (present.readInt32LE(0) && Math.abs(scale - 1) >= 1e-12) throw new Error("Apply RGB scale before loading.");
      const offset = b.offset(band, present);
      if (present.readInt32LE(0) && Math.abs(offset) >= 1e-12) throw new Error("Apply RGB offset before loading.");
      const pixels = new Uint8Array(n);
      if (g.io(band, 0, 0, 0, dsm.width, dsm.height, pixels, dsm.width, dsm.height, 1, 0, 0) !== 0
          || g.io(b.mask(band), 0, 0, 0, dsm.width, dsm.height, mask, dsm.width, dsm.height, 1, 0, 0) !== 0)
        throw new Error("Cannot read RGB pixels or validity.");
      bands.push(pixels);
      for (let i = 0; i < n; i++) if (!mask[i]) valid[i] = 0;
    }
  } finally { g.close(dataset); }
  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (dsm.valid[i] && !valid[i]) throw new Error("RGB does not cover every valid DSM pixel. Crop or prepare common source coverage explicitly.");
    if (!valid[i]) filled++;
  }
  let context = bands;
  if (filled) {
    const nearest = await tr.supportMap(valid, dsm.width, dsm.height, tr.scheduler(token));
    context = bands.map((band) => band.map((v, i) => (valid[i] ? v : band[nearest[i]])));
  }
  ds.checkCancel(token);
  return { path: path.resolve(file), sha256: ds.hashFile(file), bands, context, filled };
}

// ----- inference -------------------------------------------------------------------------------------
/**
 * pix_grad (DSM) or rgb_grad_fm (DSM, R, G, B) over the full grid; the reference is not involved. Missing
 * DSM cells are filled from DSM support only (RGB was filled from RGB support only). The channels are
 * stacked in the model's order into one Float32 raster, edge-padded right/bottom when smaller than one
 * tile; the source mask is restored and the final DTM bounded above by the DSM.
 */
async function infer(dsm, model, rgb, overlap, threads, folder, token, progress) {
  const index = rgb ? 1 : 0;
  const manifest = readJson(path.join(model, "geokernel-model.json"));
  if (manifest.modelSha256 !== MODEL_SHA256[index]) throw new Error("Unexpected AI checkpoint for the declared input profile.");
  const w = dsm.width, h = dsm.height, pw = Math.max(w, manifest.tiling.width), ph = Math.max(h, manifest.tiling.height);
  let filled = 0;
  for (const v of dsm.valid) if (!v) filled++;
  const padded = pw !== w || ph !== h;
  let z = dsm.z;
  if (filled) {
    const nearest = await tr.supportMap(dsm.valid, w, h, tr.scheduler(token));
    z = new Float32Array(w * h);
    for (let i = 0; i < z.length; i++) z[i] = dsm.valid[i] ? dsm.z[i] : dsm.z[nearest[i]];
  }
  let channels = [z, ...(rgb ? rgb.context.map((band) => Float32Array.from(band)) : [])];
  if (padded) {
    channels = channels.map((c) => {
      const grown = new Float32Array(pw * ph);
      for (let y = 0; y < ph; y++) {
        const row = Math.min(y, h - 1) * w;
        for (let x = 0; x < pw; x++) grown[y * pw + x] = c[row + Math.min(x, w - 1)];
      }
      return grown;
    });
  }
  let source = dsm.path;
  if (filled || padded || rgb) source = ds.writeFloat(path.join(folder, `${METHODS[index + 1]}-input.tif`), pw, ph, dsm.transform, dsm.projection, channels, null);
  ds.checkCancel(token);
  const output = path.join(folder, `${METHODS[index + 1]}-inference.tif`), provenance = manifest.provenance || {};
  // The C ABI call has no cancellation hook; cancellation is checked when it returns.
  const result = await ai.runInference({
    modelPackagePath: model, rasterPath: source, outputPath: output, outputMode: "floatBands", bands: channels.map((_, i) => i + 1), provider: "cpu",
    intraOpThreads: threads, interOpThreads: 1, tiling: { overlapX: overlap, overlapY: overlap }, modelRevision: provenance.revision || provenance.sourceUrl || "",
  }, (p) => progress(p.percent, `tiles ${p.completed} / ${p.total} · ${p.message}`));
  ds.checkCancel(token);
  if (result.cancelled || result.width !== pw || result.height !== ph || result.bandCount !== 1 || result.dataType !== "Float32")
    throw new Error("AI result does not match the source grid/type.");
  if (!dsm.transform.every((v, i) => v === result.geoTransform[i]) || !ai.sameCrs(dsm.projection, result.projectionWkt || ""))
    throw new Error("AI result changed the CRS or affine grid.");
  const values = ds.readRaster(output).values;
  const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) raw.set(values.subarray(y * pw, y * pw + w), y * w);
  const dtm = Float32Array.from(raw);
  let clamped = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!dsm.valid[i]) { raw[i] = dtm[i] = tr.NODATA; continue; }
    if (!Number.isFinite(raw[i]) || raw[i] === tr.NODATA) throw new Error("AI returned an invalid height on a valid DSM pixel.");
    if (dtm[i] > dsm.z[i]) { dtm[i] = dsm.z[i]; clamped++; }
  }
  return { raw, dtm, provenance: result.provenance || {}, tiles: result.processedTiles, contextFilled: filled, clamped, padded };
}

// ----- comparison ------------------------------------------------------------------------------------
const heights = (result, method) => (method ? result.ai[method - 1].dtm : result.classical.dtm);

function removal(d, dtm) {
  const removed = new Float32Array(dtm.length);
  for (let i = 0; i < removed.length; i++) removed[i] = d.valid[i] ? Math.max(0, Math.fround(d.z[i] - dtm[i])) : tr.NODATA;
  return { dtm, removed };
}

function evaluate(scene, result, archiveSha256) {
  const d = scene.dsm, ref = scene.reference, rect = ai.comparisonWindow(scene);
  const full = [0, 1, 2].map((m) => tr.score(d, heights(result, m), ref)), crop = [0, 1, 2].map((m) => ai.areaScore(d, heights(result, m), ref, rect));
  const fullJson = {}, cropJson = {}, models = {};
  METHODS.forEach((name, m) => { fullJson[name] = tr.scoreJson(full[m]); cropJson[name] = tr.scoreJson(crop[m]); });
  cropJson.pixel_window = { column: rect[0], row: rect[1], width: rect[2], height: rect[3] };
  result.ai.forEach((a, model) => {
    models[METHODS[model + 1]] = { archive_sha256: archiveSha256[model], manifest: result.modelManifests[model], sdk_inference: a.provenance,
      context_filled_dsm_pixels: a.contextFilled, small_input_edge_padding: a.padded, upper_bound_clamped_pixels: a.clamped };
  });
  const report = {
    schema_version: 1,
    experiment: "independent classical / DSM-only pix_grad / DSM+RGB rgb_grad_fm",
    source_dsm: d.path,
    source_dsm_sha256: d.sha256,
    source_rgb: scene.rgb.path,
    source_rgb_sha256: scene.rgb.sha256,
    rgb_context_filled_pixels: scene.rgb.filled,
    reference: ref ? ref.path : null,
    reference_sha256: ref ? ref.sha256 : null,
    reference_used_for_processing: false,
    methods_feed_each_other: false,
    model_input_order: "pix_grad: DSM; rgb_grad_fm: DSM, R, G, B",
    ai_options: { overlap_pixels: result.overlap, cpu_threads: result.threads, tile_pixels: 256 },
    models,
    classical: { method: tr.METHOD, parameters: tr.parametersJson(result.classical.parameters), summary: result.classical.summary },
    grid: { width: d.width, height: d.height, transform: d.transform, crs_wkt: d.projection },
    evaluation: { full: fullJson, comparison_crop: cropJson },
    source_manifest: scene.manifest,
    output_files: Object.fromEntries(Object.keys(result.files).map((name) => [name, name])),
    attribution: "Federal Office of Topography swisstopo. AI weights: David Perez, Zenodo 7973800 / 7973886, CC BY 4.0; independent deterministic ONNX adaptations.",
    interpretation: "Different pretrained checkpoints/training objectives; observed differences do not isolate the causal contribution of RGB. Fixed development scene, not a held-out benchmark. Survey years and training GSD differ or remain unverified.",
  };
  return { ...result, full, crop, report };
}

const rgbFile = async (d, file, bands) => ds.writeRgb(file, d.width, d.height, d.transform, d.projection, ...await bands);

/** Classical, then pix_grad, then rgb_grad_fm, each from the same full source grid. */
async function compare(scene, models, parameters, overlap, threads, folder, archiveSha256, token, progress) {
  const d = scene.dsm;
  const modelManifests = models.map((m) => readJson(path.join(m, "geokernel-model.json")));
  const classical = await tr.estimate(d, parameters, token, (p, text) => progress(Math.trunc(p * 0.24), `Classical: ${text}`));
  const aiHeights = [];
  for (const model of [0, 1])
    aiHeights.push(await infer(d, models[model], model ? scene.rgb : null, overlap, threads, folder, token,
      (p, text) => progress(25 + model * 29 + Math.trunc(p * 0.28), `${METHODS[model + 1]}: ${text}`)));
  const result = { classical, ai: aiHeights, overlap, threads, modelManifests, maps: [[], [], []], files: {} };
  const numeric = (name, values, type = 6) => { ds.checkCancel(token); result.files[name] = tr.writeRaster(d, path.join(folder, name), values, type); };
  for (const method of [0, 1, 2]) {
    progress(84 + method * 3, `Preparing ${METHODS[method]} outputs...`);
    await new Promise(setImmediate);
    const display = removal(d, heights(result, method));
    numeric(`${METHODS[method]}-dtm.tif`, display.dtm);
    numeric(`${METHODS[method]}-removed.tif`, display.removed);
    if (method) numeric(`${METHODS[method]}-raw.tif`, aiHeights[method - 1].raw);
    for (const mode of [0, 1, 2]) {
      const bands = mode === 0 ? tr.relief(d, display.dtm, token) : tr.diagnostic(d, display, mode === 1 ? 0 : 2, scene.reference, token);
      result.maps[method][mode] = await rgbFile(d, path.join(folder, `view-${method}-${mode}.tif`), bands);
    }
  }
  numeric("classical-qa.tif", classical.quality, 1);
  progress(96, "Writing identical source-pixel comparison crops...");
  const rect = ai.comparisonWindow(scene), cropped = ai.cutGrid(d, rect);
  const crop = (name, values) => { result.files[name] = tr.writeRaster(cropped, path.join(folder, name), ai.cutValues(values, d.width, rect), 6); };
  crop("comparison-dsm.tif", d.z);
  for (const method of [0, 1, 2]) crop(`comparison-${METHODS[method]}.tif`, heights(result, method));
  if (scene.reference) crop("comparison-reference.tif", scene.reference.z);
  const [x0, y0, w, h] = rect;
  const rgbCrop = scene.rgb.bands.map((band) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(band.subarray((y0 + y) * d.width + x0, (y0 + y) * d.width + x0 + w), y * w);
    return out;
  });
  result.files["comparison-rgb.tif"] = ds.writeRgb(path.join(folder, "comparison-rgb.tif"), w, h, cropped.transform, d.projection, ...rgbCrop);
  const scored = evaluate(scene, result, archiveSha256);
  ds.checkCancel(token);
  return scored;
}

/** New error maps, crop file and scores for a new evaluation reference; heights unchanged. */
async function attachReference(scene, result, folder, archiveSha256, token, progress) {
  const d = scene.dsm, maps = result.maps.map((m) => [...m]);
  for (const method of [0, 1, 2]) {
    progress(30 + method * 20, "Preparing reference error maps...");
    maps[method][2] = await rgbFile(d, path.join(folder, `reference-${method}.tif`), tr.diagnostic(d, { dtm: heights(result, method) }, 2, scene.reference, token));
  }
  const rect = ai.comparisonWindow(scene);
  const files = { ...result.files, "comparison-reference.tif": tr.writeRaster(ai.cutGrid(d, rect), path.join(folder, "comparison-reference.tif"), ai.cutValues(scene.reference.z, d.width, rect), 6) };
  return evaluate(scene, { ...result, maps, files }, archiveSha256);
}

const exportBundle = (result, parent, token, progress) => ai.exportBundle(result, parent, token, progress, "dsm-ortho-dtm", ".dsm-ortho-export-");

module.exports = { METHODS, sampleAssets, modelAssets, parseOptions, prepareModel, readOrtho, infer, heights, compare, attachReference, exportBundle };
