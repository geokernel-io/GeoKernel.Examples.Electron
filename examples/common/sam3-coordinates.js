"use strict";

const path = require("path");
const koffi = require("koffi");

function toSource(asset) {
  const { configureRuntimeEnvironment } = require("./geoai-runtime").sdk();
  configureRuntimeEnvironment(asset.binDir);
  const dll = koffi.load(path.join(asset.binDir, process.platform === "win32" ? "gdal.dll" : "libgdal.so"));
  const bind = (name, result, args) => dll.func(name, result, args);
  const register = bind("GDALAllRegister", "void", []);
  const open = bind("GDALOpen", "void *", ["str", "int"]);
  const close = bind("GDALClose", "void", ["void *"]);
  const projection = bind("GDALGetProjectionRef", "str", ["void *"]);
  const newSrs = bind("OSRNewSpatialReference", "void *", ["str"]);
  const importEpsg = bind("OSRImportFromEPSG", "int", ["void *", "int"]);
  const axis = bind("OSRSetAxisMappingStrategy", "void", ["void *", "int"]);
  const destroySrs = bind("OSRDestroySpatialReference", "void", ["void *"]);
  const newTransform = bind("OCTNewCoordinateTransformation", "void *", ["void *", "void *"]);
  const destroyTransform = bind("OCTDestroyCoordinateTransformation", "void", ["void *"]);
  const convert = bind("OCTTransform", "int", ["void *", "int", "void *", "void *", "void *"]);
  register();
  const dataset = open(asset.raster, 0);
  if (!dataset) throw new Error("Cannot read the source raster CRS.");
  let wkt;
  try { wkt = projection(dataset); } finally { close(dataset); }
  if (!wkt) throw new Error("Source raster has no CRS.");
  let source, destination, transform;
  try {
    source = newSrs(null);
    destination = newSrs(wkt);
    if (!source || !destination || importEpsg(source, 4326)) throw new Error("Cannot initialize prompt coordinate systems.");
    axis(source, 0); axis(destination, 0);
    transform = newTransform(source, destination);
    if (!transform) throw new Error("Cannot transform map prompts to source CRS.");
    const point = (a, b) => {
      const x = Buffer.alloc(8), y = Buffer.alloc(8), z = Buffer.alloc(8);
      x.writeDoubleLE(a); y.writeDoubleLE(b);
      if (!convert(transform, 1, x, y, z)) throw new Error("Invalid prompt coordinate.");
      const result = [x.readDoubleLE(), y.readDoubleLE()];
      if (!result.every(Number.isFinite)) throw new Error("Invalid transformed prompt coordinate.");
      return result;
    };
    const points = asset.points.map(p => { const [x, y] = point(p.x, p.y); return { x, y, positive: p.positive }; });
    let box = null;
    if (asset.box) {
      const [a, b, c, d] = asset.box;
      const corners = [point(a, b), point(a, d), point(c, b), point(c, d)];
      box = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
        Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
    }
    return { points, box };
  } finally {
    if (transform) destroyTransform(transform);
    if (destination) destroySrs(destination);
    if (source) destroySrs(source);
  }
}

module.exports = { toSource };
