"use strict";

const DATA = {
  url: "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/spain_sentinel2_l1c.zip",
  sha: "07811e9600882c526185268c5b280134e5715c95042754e414d6736fa5647839", required: "dynamicworld_spain_sentinel2_l1c.tif",
};
const MODEL = {
  url: "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/google-dynamicworld-geokernel-onnx-v1.zip",
  sha: "326bb2899cdea6e620a02f5e16fd330ec848e0a5b76f72f576038d7bc1e0aa63", required: "geokernel-model.json",
};
const DYNAMIC_WORLD = {
  task: "dynamic-world", title: "Google Dynamic World — land cover", data: DATA, model: MODEL,
  displayName: "dynamicworld_spain_rgb.tif", sourceName: "Spain Sentinel-2 RGB source",
  runLabel: "Run land-cover classification", exportName: "dynamic-world.shp",
  description: "Spain / Alicante · 512 × 512 · Sentinel-2 L1C, nine bands, 10 m.",
  legend: "Water · Trees · Grass · Flooded vegetation · Crops · Shrub and scrub · Built · Bare · Snow and ice\n\nContains modified Copernicus Sentinel data 2019.\nModel: Google / National Geographic / WRI; Apache-2.0. Retain downloaded notices.",
};
const HOTOSM = {
  task: "hotosm-buildings", title: "HOTOSM DINOv3-S — building footprints", buildings: true,
  data: {
    url: "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/buildings.zip",
    sha: "f7cb0554b54c8e8bf31d576c38f988a8902382ad2ec3db3de6de05f5dbfb6f2b", required: "buildings.tif",
  },
  model: {
    url: "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/hotosm-dinov3s-buildings-geokernel-onnx-v1.zip",
    sha: "3a6cd11e013f81b46b3db700feddef2d98319780285b8320e1200573684b24bb", required: "geokernel-model.json",
  },
  displayName: "buildings.tif", sourceName: "Buildings RGB source",
  runLabel: "Run building segmentation inference", exportName: "building-footprints.shp",
  description: "Buildings RGB sample · 2503 × 1126 · original resolution.",
  legend: "Building footprints are predictions, not ground truth or cadastral boundaries.\n\nModel: HOTOSM / Meta DINOv3. CC-BY-4.0 plus separate DINOv3 License; retain all package notices.\nImagery source/license not verified.",
};
const GEOAI_USA = {
  ...HOTOSM,
  task: "geoai-usa-buildings", title: "GeoAI USA — Mask R-CNN building footprints",
  thresholdLabel: "Confidence threshold",
  model: {
    url: "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/giswqs-geoai-usa-maskrcnn-resnet50-fpn-geokernel-onnx-v1.zip",
    sha: "055097781e125083201421c37c70d36336f2f968b69b1aa09350578d2c87ca32", required: "geokernel-model.json",
  },
  description: "Buildings RGB sample · USA-trained Mask R-CNN · original resolution.",
  legend: "Building footprints are predictions, not ground truth or cadastral boundaries.\n\nModel: giswqs/geoai — Mask R-CNN ResNet50 FPN. MIT model declaration; retain package notices.\nImagery source/license not verified.",
};
const PRITHVI = {
  task: "prithvi-flood", title: "IBM/NASA Prithvi EO 2.0 — flood analysis",
  spectralPreview: "prithvi-rgb",
  data: {
    url: "https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/flood_analysis.zip",
    sha: "059e9a84bed08ea5da76941432e6e8409bd1352661ff72f750e47df5f740c38f", required: "India_900498_S2Hand.tif",
  },
  model: {
    url: "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/ibm-nasa-prithvi-eo2-300m-tl-sen1floods11-geokernel-onnx-v1.zip",
    sha: "34711ae55d48fe265b19c18551aef4b4aa84045a07bffb407161570b19429c13", required: "geokernel-model.json",
  },
  sourceName: "Sentinel-2 RGB source", runLabel: "Run flood analysis", exportName: "flood-extent.shp",
  description: "India · Sentinel-2 L1C · 512 × 512 · original spectral source.",
  interpretation: "Class 0: non-water; class 1: water/flood. Shapefile exports only class 1. A single image does not distinguish permanent water from newly flooded land.",
  legend: "Non-water · Water / flood\n\nModel: IBM / NASA Prithvi EO 2.0; Apache-2.0.\nImagery: Copernicus / Sen1Floods11 (Cloud to Street). Retain package/source notices.",
};
const PRUE = {
  task: "prue-fields", title: "Fields of The World / PRUE — field boundaries",
  spectralPreview: "prue-rgb",
  data: {
    url: "https://raw.githubusercontent.com/fieldsoftheworld/ftw-baselines/779b809813b301de7fb9f00f0c5db07086b23227/tests/data-files/inference-img.tif",
    sha: "da482e7987b36898bd9f8381e7c7fe95c05dfc5ccbba19a58eb65e544d1af750", required: "inference-img.tif", archive: false,
  },
  model: {
    url: "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/fieldsoftheworld-prue-efficientnet-b5-ccby-geokernel-onnx-v2.zip",
    sha: "0035f723ae5753eb861e056bbb38b60605617485c9700cc16d3317856374da44", required: "geokernel-model.json",
  },
  sourceName: "Sentinel-2 first-period RGB source", runLabel: "Run field boundary segmentation", exportName: "field-interiors.shp",
  description: "FTW Sentinel-2 sample · 578 × 379 · two periods, eight bands.",
  interpretation: "Class 0: background; class 1: field interior; class 2: boundary. Shapefile exports only class-1 interiors. Image-derived field divisions are not legal/cadastral parcels.",
  legend: "Background · Field interior · Field boundary\n\nModel: FTW / PRUE EfficientNet-B5 CC-BY. Weights: CC-BY-4.0; upstream code: MIT.\nImagery: Sentinel-2 / FTW test sample; retain source notices.",
};
module.exports = { DYNAMIC_WORLD, HOTOSM, GEOAI_USA, PRITHVI, PRUE };
