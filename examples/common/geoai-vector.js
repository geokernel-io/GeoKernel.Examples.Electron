"use strict";

const fs = require("fs");
const path = require("path");

function prepareVectorPreview(asset, check) {
  const koffi = require("koffi");
  require("./geoai-runtime").sdk().configureRuntimeEnvironment(asset.binDir);
  const dll = koffi.load(path.join(asset.binDir, process.platform === "win32" ? "gdal.dll" : "libgdal.so"));
  const bind = (name, result, args) => dll.func(name, result, args);
  const register = bind("GDALAllRegister", "void", []);
  const open = bind("GDALOpenEx", "void *", ["str", "uint", "void *", "void *", "void *"]);
  const close = bind("GDALClose", "void", ["void *"]);
  const optionsNew = bind("GDALVectorTranslateOptionsNew", "void *", ["str *", "void *"]);
  const optionsFree = bind("GDALVectorTranslateOptionsFree", "void", ["void *"]);
  const translate = bind("GDALVectorTranslate", "void *", ["str", "void *", "int", "void **", "void *", "void *"]);
  const outputPath = path.join(path.dirname(asset.vectorPath), "viewer-preview.geojson");
  let source, options, output, complete = false;
  try {
    check();
    register();
    source = open(asset.vectorPath, 4, null, null, null);
    if (!source) throw new Error("Cannot open building polygons for display.");
    options = optionsNew(["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-dim", "XY", null], null);
    if (!options) throw new Error("Cannot configure building polygon display.");
    const usageError = Buffer.alloc(4);
    output = translate(outputPath, null, 1, [source], options, usageError);
    if (!output || usageError.readInt32LE()) throw new Error("Cannot transform building polygons for display.");
    close(output);
    output = null;
    check();
    complete = true;
    return outputPath;
  } finally {
    if (output) close(output);
    if (options) optionsFree(options);
    if (source) close(source);
    if (!complete) fs.rmSync(outputPath, { force: true });
  }
}

function applyVectorOpacity(viewer, percent) {
  const opacity = percent / 100;
  // Apply transparency once: scaling both brush alpha and layer opacity makes footprints too faint.
  const style = {
    fillColor: "#ef5350", fillOpacity: 255,
    lineColor: "#ffdd55", lineWidth: 1.5,
  };
  viewer.setLayerStyle(0, style);
  viewer.setLayerOpacity(0, opacity);
  viewer.setLayerVisible(0, percent > 0);
  viewer.refreshLayers();
}

module.exports = { prepareVectorPreview, applyVectorOpacity };
