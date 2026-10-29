"use strict";
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  crypto = require("crypto"),
  koffi = require("koffi");
const { sdk } = require("../common/geoai-runtime");
const { HOTOSM } = require("../common/geoai-profiles");
const DATA = {
  url: "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/almere_oosterwold_change_2016_2025_v1.zip",
  sha: "ecc35ef2c6bbdd586adc6ecc812ce1c74aee62fbf8e404de1d63b75bf7137a88",
  required: "oosterwold_2016-epsg25831-50cm.tif",
};
const FILES = [
  "oosterwold_2016-epsg25831-50cm.tif",
  "oosterwold_2025-epsg25831-50cm.tif",
];
const HASHES = [
  "db723783db4c8738a716fe8b898de2e3099bab9394e335bd489db2412ae0c5c3",
  "7b1b12d8b27cd0714f140415004daf9fd0000495eda31366c7cd4aab218caa82",
];
const BOUNDS = [657533, 5800382, 658557, 5801406],
  DEMO = [657885, 5800734, 658205, 5801054];
const ATTRIBUTION =
  "Beeldmateriaal Nederland / PDOK, 2016 & 2025, CC BY 4.0. WMS crop/reprojection rendered at 0.5 m. Model: HOTOSM / Meta DINOv3; retain package licenses.";
const PROFILES = {
  Conservative: {
    area: 50,
    coverage: 0.1,
    tolerance: 2,
    own: 0.75,
    other: 0.2,
  },
  Balanced: { area: 20, coverage: 0.2, tolerance: 1, own: 0.55, other: 0.35 },
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest("hex");
const fileHash = (p) => hash(fs.readFileSync(p));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function rectangle([a, b, c, d]) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [a, b],
        [c, b],
        [c, d],
        [a, d],
        [a, b],
      ],
    ],
  };
}
function envelope(geometry) {
  const points = [];
  function walk(a) {
    if (typeof a[0] === "number") points.push(a);
    else a.forEach(walk);
  }
  walk(geometry.coordinates);
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}

class Gdal {
  constructor(bin) {
    sdk().configureRuntimeEnvironment(bin);
    this.lib = koffi.load(path.join(bin, "gdal.dll"));
    for (const [name, [result, args]] of Object.entries(
      require("./gdal-signatures.json"),
    ))
      this[name] = this.lib.func(name, result, args);
    this.GDALAllRegister();
  }
  check(code) {
    if (code) throw Error("GDAL operation failed.");
  }
  open(file) {
    const ds = this.GDALOpen(file, 0);
    if (!ds) throw Error(`Cannot open ${file}`);
    return ds;
  }
  displayRaster(source, destination) {
    // The map needs WGS84 pixels; inference retains the original metre grid.
    const ds = this.open(source);
    let warped, output;
    try {
      warped = this.GDALAutoCreateWarpedVRT(ds, null, "EPSG:4326", 1, 0, null);
      if (!warped) throw Error("Cannot reproject imagery for the map.");
      output = this.GDALCreateCopy(
        this.GDALGetDriverByName("GTiff"),
        destination,
        warped,
        0,
        null,
        null,
        null,
      );
      if (!output) throw Error("Cannot create the map preview.");
      const { width, height, gt } = this.metadata(output);
      if (
        width < 1 ||
        height < 1 ||
        !(gt[0] >= -180 && gt[0] <= 180 && gt[3] >= -90 && gt[3] <= 90)
      )
        throw Error("Map preview was not reprojected to WGS84.");
      return destination;
    } finally {
      if (output) this.GDALClose(output);
      if (warped) this.GDALClose(warped);
      this.GDALClose(ds);
    }
  }
  metadata(ds) {
    const bytes = Buffer.alloc(48);
    this.check(this.GDALGetGeoTransform(ds, bytes));
    return {
      width: this.GDALGetRasterXSize(ds),
      height: this.GDALGetRasterYSize(ds),
      gt: Array.from({ length: 6 }, (_, i) => bytes.readDoubleLE(i * 8)),
      crs: this.GDALGetProjectionRef(ds),
    };
  }
  read(ds, band, integer = false) {
    const g = this.metadata(ds),
      bytes = Buffer.alloc(g.width * g.height * 4);
    this.check(
      this.GDALRasterIO(
        this.GDALGetRasterBand(ds, band),
        0,
        0,
        0,
        g.width,
        g.height,
        bytes,
        g.width,
        g.height,
        integer ? 5 : 6,
        0,
        0,
      ),
    );
    return integer
      ? new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
      : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  }
  json(geom) {
    const p = this.OGR_G_ExportToJson(geom);
    if (!p) throw Error("Cannot serialize geometry.");
    try {
      return JSON.parse(koffi.decode(p, "char", -1));
    } finally {
      this.VSIFree(p);
    }
  }
  crop(source, bounds, target) {
    const ds = this.open(source);
    let out;
    try {
      const g = this.metadata(ds),
        t = g.gt;
      if (
        t[1] !== 0.5 ||
        t[5] !== -0.5 ||
        t[2] ||
        t[4] ||
        !g.crs.includes("25831")
      )
        throw Error("Expected the pinned EPSG:25831 0.5m grid.");
      const x = Math.max(0, Math.floor((bounds[0] - t[0]) / 0.5)),
        y = Math.max(0, Math.floor((t[3] - bounds[3]) / 0.5)),
        w = Math.min(g.width, Math.ceil((bounds[2] - t[0]) / 0.5)) - x,
        h = Math.min(g.height, Math.ceil((t[3] - bounds[1]) / 0.5)) - y;
      if (w <= 0 || h <= 0)
        throw Error("Analysis area does not intersect the imagery.");
      out = this.GDALCreate(
        this.GDALGetDriverByName("GTiff"),
        target,
        w,
        h,
        3,
        6,
        null,
      );
      if (!out) throw Error("Cannot create crop.");
      this.check(this.GDALSetProjection(out, g.crs));
      const gt = Buffer.alloc(48);
      [t[0] + x * 0.5, 0.5, 0, t[3] - y * 0.5, 0, -0.5].forEach((v, i) =>
        gt.writeDoubleLE(v, i * 8),
      );
      this.check(this.GDALSetGeoTransform(out, gt));
      for (let band = 1; band <= 3; band++) {
        const a = Buffer.alloc(w * h * 4);
        this.check(
          this.GDALRasterIO(
            this.GDALGetRasterBand(ds, band),
            0,
            x,
            y,
            w,
            h,
            a,
            w,
            h,
            6,
            0,
            0,
          ),
        );
        this.check(
          this.GDALRasterIO(
            this.GDALGetRasterBand(out, band),
            1,
            0,
            0,
            w,
            h,
            a,
            w,
            h,
            6,
            0,
            0,
          ),
        );
        this.check(
          this.GDALSetRasterColorInterpretation(
            this.GDALGetRasterBand(out, band),
            band + 2,
          ),
        );
      }
    } finally {
      if (out) this.GDALClose(out);
      this.GDALClose(ds);
    }
  }
  geometry(value, source = 4326, target = 25831) {
    const geom = this.OGR_G_CreateGeometryFromJson(JSON.stringify(value));
    if (!geom) throw Error("Invalid geometry JSON.");
    let a, b, operation;
    try {
      if (!this.OGR_G_IsValid(geom))
        throw Error("Invalid polygon; repair before approval.");
      if (source !== target) {
        a = this.OSRNewSpatialReference(null);
        b = this.OSRNewSpatialReference(null);
        this.check(this.OSRImportFromEPSG(a, source));
        this.check(this.OSRImportFromEPSG(b, target));
        this.OSRSetAxisMappingStrategy(a, 0);
        this.OSRSetAxisMappingStrategy(b, 0);
        operation = this.OCTNewCoordinateTransformation(a, b);
        if (!operation) throw Error("Cannot transform geometry.");
        this.check(this.OGR_G_Transform(geom, operation));
      }
      return { geometry: this.json(geom), area: this.OGR_G_Area(geom) };
    } finally {
      this.OGR_G_DestroyGeometry(geom);
      if (operation) this.OCTDestroyCoordinateTransformation(operation);
      if (a) this.OSRDestroySpatialReference(a);
      if (b) this.OSRDestroySpatialReference(b);
    }
  }
  polygonsAndLabels(file, g) {
    const ds = this.GDALOpenEx(file, 4, null, null, null);
    if (!ds) throw Error("Cannot open predicted polygons.");
    let mem;
    try {
      const layer = this.GDALDatasetGetLayer(ds, 0);
      if (!layer) throw Error("Prediction layer missing.");
      const polygons = [];
      let f;
      while ((f = this.OGR_L_GetNextFeature(layer))) {
        try {
          const geom = this.OGR_F_GetGeometryRef(f);
          if (!geom || !this.OGR_G_IsValid(geom)) continue;
          const field = this.OGR_F_GetFieldIndex(f, "instance_id");
          if (field < 0) throw Error("Missing instance_id.");
          polygons.push({
            id: this.OGR_F_GetFieldAsInteger(f, field),
            geometry: this.json(geom),
            area: this.OGR_G_Area(geom),
          });
        } finally {
          this.OGR_F_Destroy(f);
        }
      }
      mem = this.GDALCreate(
        this.GDALGetDriverByName("MEM"),
        "",
        g.width,
        g.height,
        1,
        5,
        null,
      );
      if (!mem) throw Error("Cannot create label grid.");
      this.check(this.GDALSetProjection(mem, g.crs));
      const gt = Buffer.alloc(48);
      g.gt.forEach((v, i) => gt.writeDoubleLE(v, i * 8));
      this.check(this.GDALSetGeoTransform(mem, gt));
      if (polygons.length) {
        this.OGR_L_ResetReading(layer);
        this.check(
          this.GDALRasterizeLayers(
            mem,
            1,
            [1],
            1,
            [layer],
            null,
            null,
            null,
            ["ATTRIBUTE=instance_id", null],
            null,
            null,
          ),
        );
      }
      return { polygons, labels: this.read(mem, 1, true) };
    } finally {
      if (mem) this.GDALClose(mem);
      this.GDALClose(ds);
    }
  }
}

function dilate(scores, w, h, r) {
  const a = new Uint8Array(scores.length),
    b = new Uint8Array(scores.length);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < Math.min(w, r + 1); x++) n += scores[y * w + x] >= 0.25;
    for (let x = 0; x < w; x++) {
      a[y * w + x] = n > 0;
      if (x - r >= 0) n -= scores[y * w + x - r] >= 0.25;
      if (x + r + 1 < w) n += scores[y * w + x + r + 1] >= 0.25;
    }
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(h, r + 1); y++) n += a[y * w + x];
    for (let y = 0; y < h; y++) {
      b[y * w + x] = n > 0;
      if (y - r >= 0) n -= a[(y - r) * w + x];
      if (y + r + 1 < h) n += a[(y + r + 1) * w + x];
    }
  }
  return b;
}

async function analyze(
  { paths, model, bounds, policy, threshold, provider, bin },
  check,
  progress,
) {
  const { AITasks, AI } = sdk(),
    g = new Gdal(bin),
    tasks = new AITasks({ binDir: bin }),
    ai = new AI({ binDir: bin }),
    dates = [],
    started = Date.now(),
    work = fs.mkdtempSync(path.join(os.tmpdir(), "geokernel-change-"));
  try {
    for (let date = 0; date < 2; date++) {
      check();
      const year = date ? 2025 : 2016,
        crop = path.join(work, `${year}.tif`);
      g.crop(paths[date], bounds, crop);
      const task = tasks.start({
        task: "hotosm-buildings",
        modelPackagePath: model,
        rasterPath: crop,
        threshold,
        provider,
        intraOpThreads: 2,
      });
      try {
        while (true) {
          try {
            check();
          } catch (e) {
            task.cancel();
            throw e;
          }
          const s = task.status();
          progress(
            date * 45 + Math.floor(s.percent * 0.3),
            `${year}: ${s.message}`,
          );
          if (s.state === "failed") throw Error(s.error);
          if (s.state === "cancelled") throw Error("Cancelled.");
          if (s.state === "completed") break;
          await pause(80);
        }
        check();
        const native = task.result();
        let ds = g.open(crop),
          grid;
        try {
          grid = g.metadata(ds);
        } finally {
          g.GDALClose(ds);
        }
        const { polygons, labels } = g.polygonsAndLabels(
            native.vectorPath,
            grid,
          ),
          raw = path.join(work, `${year}-scores.tif`);
        progress(date * 45 + 31, `${year}: matching scores…`);
        await new Promise((resolve, reject) =>
          ai.run.async(
            JSON.stringify({
              modelPackagePath: model,
              rasterPath: crop,
              outputMode: "floatBands",
              outputPath: raw,
              bands: [1, 2, 3],
              provider,
              intraOpThreads: 2,
              interOpThreads: 1,
            }),
            null,
            null,
            (error, value) => {
              if (error) reject(error);
              else if (value === null)
                reject(Error("Native score inference failed."));
              else resolve(JSON.parse(value));
            },
          ),
        );
        check();
        ds = g.open(raw);
        let scores;
        try {
          if (JSON.stringify(g.metadata(ds)) !== JSON.stringify(grid))
            throw Error("Score and instance grids differ.");
          scores = g.read(ds, 1);
        } finally {
          g.GDALClose(ds);
        }
        for (let i = 0; i < scores.length; i++) {
          if (!Number.isFinite(scores[i]))
            throw Error("Nonfinite model logits.");
          scores[i] =
            1 / (1 + Math.exp(-Math.max(-80, Math.min(80, scores[i]))));
        }
        dates.push({ native, grid, polygons, labels, scores });
      } finally {
        await task.close();
      }
    }
    if (JSON.stringify(dates[0].grid) !== JSON.stringify(dates[1].grid))
      throw Error("Date grids differ.");
    const features = [];
    let edgeCount = 0,
      matched = 0;
    for (const date of [1, 0]) {
      check();
      const own = dates[date],
        other = dates[1 - date],
        { width: w, height: h } = own.grid;
      let max = 0;
      for (const id of own.labels) max = Math.max(max, id);
      const counts = new Uint32Array(max + 1),
        covered = new Uint32Array(max + 1),
        ownSum = new Float64Array(max + 1),
        otherSum = new Float64Array(max + 1),
        edge = new Set(),
        mask = dilate(other.scores, w, h, Math.ceil(policy.tolerance / 0.5));
      for (let y = 0; y < h; y++) {
        check();
        for (let x = 0; x < w; x++) {
          const p = y * w + x,
            id = own.labels[p];
          counts[id]++;
          covered[id] += mask[p];
          ownSum[id] += own.scores[p];
          otherSum[id] += other.scores[p];
          if (id > 0 && (x === 0 || y === 0 || x === w - 1 || y === h - 1))
            edge.add(id);
        }
      }
      edgeCount += edge.size;
      const seen = new Set();
      for (const polygon of own.polygons) {
        const id = polygon.id;
        if (
          edge.has(id) ||
          counts[id] * 0.25 < policy.area ||
          polygon.area < policy.area
        )
          continue;
        const mean = ownSum[id] / counts[id],
          opposite = otherSum[id] / counts[id],
          coverage = covered[id] / counts[id];
        if (
          mean < policy.own ||
          opposite > policy.other ||
          coverage >= policy.coverage
        ) {
          if (!seen.has(id)) {
            matched++;
            seen.add(id);
          }
          continue;
        }
        const geometry = g.geometry(polygon.geometry, 25831, 4326).geometry,
          kind = date ? "new" : "removed",
          identifier = `${kind}-${String(features.length + 1).padStart(4, "0")}`;
        features.push({
          type: "Feature",
          id: identifier,
          geometry,
          properties: {
            candidate_id: identifier,
            change_type: kind,
            review_status: "pending",
            review_note: "",
            reviewed_by: "",
            area_m2: polygon.area,
            source_instance_id: id,
            building_score: mean,
            other_date_score: opposite,
            other_date_coverage: coverage,
            before_year: 2016,
            after_year: 2025,
          },
        });
      }
    }
    progress(100, "Complete");
    return {
      type: "FeatureCollection",
      features,
      geokernel_provenance: {
        dataset_url: DATA.url,
        dataset_archive_sha256: DATA.sha,
        before_sha256: HASHES[0],
        after_sha256: HASHES[1],
        before_year: 2016,
        after_year: 2025,
        source_crs: "EPSG:25831",
        model_id: "hotosm-dinov3s-buildings",
        model_archive_sha256: HOTOSM.model.sha,
        model_sha256: fileHash(path.join(model, "model.onnx")),
        threshold,
        filters: policy,
        weak_building_threshold: 0.25,
        provider: dates[0].native.provider,
        analysis_geotransform: dates[0].grid.gt,
        analysis_width: dates[0].grid.width,
        analysis_height: dates[0].grid.height,
        elapsed_seconds: (Date.now() - started) / 1000,
        attribution: ATTRIBUTION,
        imagery_license: "https://creativecommons.org/licenses/by/4.0/",
        method:
          "Native HOTOSM instances plus second FloatBands score pass; sigmoid after logit blending. Same filter policy as Qt; not bit-identical to per-tile decoded scoring. Predictions require review.",
      },
      stats: {
        before: dates[0].native.instances,
        after: dates[1].native.instances,
        edge: edgeCount,
        matched,
        elapsed: (Date.now() - started) / 1000,
      },
    };
  } finally {
    const resolved = path.resolve(work);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("geokernel-change-")
    )
      throw Error("Unexpected workspace cleanup path.");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function update(feature, geometry, g) {
  if (hash(feature.geometry) === hash(geometry)) return false;
  const { area } = g.geometry(geometry);
  feature.geometry = geometry;
  Object.assign(feature.properties, {
    area_m2: area,
    review_status: "pending",
    reviewed_by: "",
    review_note: "Geometry edited; review again.",
  });
  delete feature.approved_geometry_sha256;
  return true;
}
function review(feature, status, actor, note, g) {
  if (!["approved", "rejected", "pending"].includes(status) || !actor.trim())
    throw Error("Enter a reviewer and a valid decision.");
  if (status === "approved") {
    feature.properties.area_m2 = g.geometry(feature.geometry).area;
    feature.approved_geometry_sha256 = hash(feature.geometry);
  } else delete feature.approved_geometry_sha256;
  Object.assign(feature.properties, {
    review_status: status,
    reviewed_by: actor.trim(),
    review_note: note.trim(),
  });
}
function exportApproved(result, target, g) {
  const features = [];
  for (const f of result.features) {
    if (f.properties.review_status !== "approved") continue;
    if (f.approved_geometry_sha256 !== hash(f.geometry))
      throw Error("Geometry changed; approve again.");
    g.geometry(f.geometry);
    const copy = structuredClone(f);
    delete copy.approved_geometry_sha256;
    features.push(copy);
  }
  if (!features.length) throw Error("Approve at least one candidate.");
  const temporary = target + ".part";
  fs.writeFileSync(
    temporary,
    JSON.stringify(
      {
        type: "FeatureCollection",
        features,
        geokernel_provenance: result.geokernel_provenance,
      },
      null,
      2,
    ),
  );
  fs.renameSync(temporary, target);
}
module.exports = {
  DATA,
  FILES,
  HASHES,
  BOUNDS,
  DEMO,
  ATTRIBUTION,
  PROFILES,
  Gdal,
  analyze,
  update,
  review,
  exportApproved,
  rectangle,
  envelope,
  fileHash,
};
