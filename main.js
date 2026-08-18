"use strict";

const { app } = require("electron");
const path = require("path");

// All examples use the repository-owned icon set instead of icons bundled
// inside the geokernel-electron package.
process.env.GEOKERNEL_ICON_DIR = path.join(__dirname, "images");

const EXAMPLES = {
  "stac-cog-load": "./examples/stac-cog-load/main",
  "duckdb-geo-parquet-analytics": "./examples/duckdb-geo-parquet-analytics/main",
  "add-layers": "./examples/add-layers/main",
  "hello-map": "./examples/hello-map/main",
  "layer-add-remove": "./examples/layer-add-remove/main",
  "layer-reorder": "./examples/layer-reorder/main",
  "layer-visibility": "./examples/layer-visibility/main",
  "layer-zoom-to": "./examples/layer-zoom-to/main",
  "layer-extent": "./examples/layer-extent/main",
  "layer-refresh": "./examples/layer-refresh/main",
  "layer-load-options": "./examples/layer-load-options/main",
  "layer-load-cancel": "./examples/layer-load-cancel/main",
  "busy-callback": "./examples/busy-callback/main",
  "layer-events": "./examples/layer-events/main",
  "in-memory-layers": "./examples/in-memory-layers/main",
  "minimap": "./examples/minimap/main",
  "multi-window-sync": "./examples/multi-window-sync/main",
  "measure": "./examples/measure/main",
  "project": "./examples/project/main",
  "scalebar": "./examples/scalebar/main",
  "simple-style": "./examples/simple-style/main",
  "selection-style": "./examples/selection-style/main",
  "categorized-renderer": "./examples/categorized-renderer/main",
  "graduated-renderer": "./examples/graduated-renderer/main",
  "graduated-renderer-size": "./examples/graduated-renderer-size/main",
  "rule-based-renderer": "./examples/rule-based-renderer/main",
  "classification-methods": "./examples/classification-methods/main",
  "scale-based-layer-visibility": "./examples/scale-based-layer-visibility/main",
  "style-per-feature": "./examples/style-per-feature/main",
  "clear-renderer": "./examples/clear-renderer/main",
  "classification": "./examples/classification/main",
  "basic-label": "./examples/basic-label/main",
  "label-font": "./examples/label-font/main",
  "label-halo": "./examples/label-halo/main",
  "label-offset": "./examples/label-offset/main",
  "label-rotation": "./examples/label-rotation/main",
  "label-collision-off": "./examples/label-collision-off/main",
  "edit-session": "./examples/edit-session/main",
  "edit-and-save": "./examples/edit-and-save/main",
  "add-point-interactive": "./examples/add-point-interactive/main",
  "add-polyline-interactive": "./examples/add-polyline-interactive/main",
  "add-polygon-interactive": "./examples/add-polygon-interactive/main",
  "add-point-programmatic": "./examples/add-point-programmatic/main",
  "add-polyline-programmatic": "./examples/add-polyline-programmatic/main",
  "add-polygon-programmatic": "./examples/add-polygon-programmatic/main",
  "add-with-attributes": "./examples/add-with-attributes/main",
  "delete-feature": "./examples/delete-feature/main",
  "move-feature-tool": "./examples/move-feature-tool/main",
  "move-feature-programmatic": "./examples/move-feature-programmatic/main",
  "edit-vertices-tool": "./examples/edit-vertices-tool/main",
  "insert-vertex": "./examples/insert-vertex/main",
  "delete-vertex": "./examples/delete-vertex/main",
  "undo-redo": "./examples/undo-redo/main",
  "set-attributes": "./examples/set-attributes/main",
  "snapping-enabled": "./examples/snapping-enabled/main",
  "edit-dirty-state": "./examples/edit-dirty-state/main",
  "edit-session-signals": "./examples/edit-session-signals/main",
  "multi-layer-edit": "./examples/multi-layer-edit/main",
  "can-edit-check": "./examples/can-edit-check/main",
  "click-hit-test": "./examples/click-hit-test/main",
  "all-features-at-point": "./examples/all-features-at-point/main",
  "world-tolerance": "./examples/world-tolerance/main",
  "box-select": "./examples/box-select/main",
  "select-add": "./examples/select-add/main",
  "select-clear": "./examples/select-clear/main",
  "zoom-to-selection": "./examples/zoom-to-selection/main",
  "feature-attributes": "./examples/feature-attributes/main",
  "selection-signal": "./examples/selection-signal/main",
  "info-tool": "./examples/info-tool/main",
  "map-clicked-signal": "./examples/map-clicked-signal/main",
  "selection-box-signal": "./examples/selection-box-signal/main",
  "coordinate-transform": "./examples/coordinate-transform/main",
  "crs-database": "./examples/crs-database/main",
  "crs-by-authority": "./examples/crs-by-authority/main",
  "on-the-fly-reproject": "./examples/on-the-fly-reproject/main",
  "alternative-routes": "./examples/alternative-routes/main",
  "multi-stop-route": "./examples/multi-stop-route/main",
  "shortest-route": "./examples/shortest-route/main",
  "route-animation": "./examples/route-animation/main",
  "isochrone": "./examples/isochrone/main",
  "route-optimization": "./examples/route-optimization/main",
  "web-mercator": "./examples/web-mercator/main",
  "wgs84-setup": "./examples/wgs84-setup/main",
  "shapefile-load": "./examples/shapefile-load/main",
  "shapefile-save-as": "./examples/shapefile-save-as/main",
  "tab-load": "./examples/tab-load/main",
  "mif-load": "./examples/mif-load/main",
  "kml-load": "./examples/kml-load/main",
  "geo-package-load": "./examples/geo-package-load/main",
  "dxf-load": "./examples/dxf-load/main",
  "open-street-map": "./examples/open-street-map/main",
  "xyz-presets": "./examples/xyz-presets/main",
  "xyz-custom-url": "./examples/xyz-custom-url/main",
  "xyz-local-cache": "./examples/xyz-local-cache/main",
  "xyz-tile-size": "./examples/xyz-tile-size/main",
  "xyz-min-max-zoom": "./examples/xyz-min-max-zoom/main",
  "xyz-attribution": "./examples/xyz-attribution/main",
  "xyz-diagnostics": "./examples/xyz-diagnostics/main",
  "geo-tiff-load": "./examples/geo-tiff-load/main",
  "ecw-load": "./examples/ecw-load/main",
  "raster-world-transform": "./examples/raster-world-transform/main",
  "raster-overview": "./examples/raster-overview/main",
  "raster-tile-cache": "./examples/raster-tile-cache/main",
  "wkt-read-point": "./examples/wkt-read-point/main",
  "wkt-read-polyline": "./examples/wkt-read-polyline/main",
  "wkt-read-polygon": "./examples/wkt-read-polygon/main",
  "wkt-write": "./examples/wkt-write/main",
  "wkt-roundtrip": "./examples/wkt-roundtrip/main",
  "wkt-overlay": "./examples/wkt-overlay/main",
  "geo-json-read": "./examples/geo-json-read/main",
  "geo-json-write": "./examples/geo-json-write/main",
  "wkb-write": "./examples/wkb-write/main",
  "wkb-read": "./examples/wkb-read/main",
  "extent-operations": "./examples/extent-operations/main",
  "buffer-point": "./examples/buffer-point/main",
  "buffer-polyline": "./examples/buffer-polyline/main",
  "buffer-polygon": "./examples/buffer-polygon/main",
  "buffer-animated": "./examples/buffer-animated/main",
  "union": "./examples/union/main",
  "union-on-list": "./examples/union-on-list/main",
  "intersection": "./examples/intersection/main",
  "difference": "./examples/difference/main",
  "sym-difference": "./examples/sym-difference/main",
  "convex-hull-shape": "./examples/convex-hull-shape/main",
  "convex-hull-two": "./examples/convex-hull-two/main",
  "split-by-arc": "./examples/split-by-arc/main",
  "arc-operations": "./examples/arc-operations/main",
  "topology-check": "./examples/topology-check/main",
  "topology-fix": "./examples/topology-fix/main",
  "find-delete-loops": "./examples/find-delete-loops/main",
  "spatial-relate": "./examples/spatial-relate/main",
  "spatial-predicates": "./examples/spatial-predicates/main",
  "get-crossings": "./examples/get-crossings/main",
  "shape-simplify": "./examples/shape-simplify/main",
  "shape-centroid": "./examples/shape-centroid/main",
  "tolerance-config": "./examples/tolerance-config/main",
  "topology-batch": "./examples/topology-batch/main",
  "topology": "./examples/topology/main",
};

function resolveExampleName(value) {
  if (!value) {
    return "hello-map";
  }

  if (EXAMPLES[value]) {
    return value;
  }

  const relativePath = path.isAbsolute(value)
    ? path.relative(process.cwd(), value)
    : value;
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const match = normalizedPath.match(/(?:^|\/)examples\/([^/]+)(?:\/|$)/);
  if (match && EXAMPLES[match[1]]) {
    return match[1];
  }

  return value;
}

const exampleName = resolveExampleName(process.argv[2]);
let activeExample = null;

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.whenReady().then(async () => {
  const modulePath = EXAMPLES[exampleName];
  if (!modulePath) {
    throw new Error(`Unknown GeoKernel Electron example: ${exampleName}`);
  }

  activeExample = require(modulePath);
  await activeExample.start();
}).catch(fail);

app.on("before-quit", () => {
  activeExample?.stop?.();
  activeExample = null;
});
