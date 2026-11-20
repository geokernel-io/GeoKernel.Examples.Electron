# DSM to DTM — live classical processing (Electron)

Electron port of the Qt `DsmToDtmProcessing` example: **run a classical DSM-to-DTM
conversion on the input DSM**, change parameters, inspect the newly generated terrain and
export numeric GeoTIFFs. Three linked native GeoKernel **2D maps** placed over the page
show the original DSM, the generated DTM and a selectable diagnostic map. The algorithm is
in [terrain-support.js](terrain-support.js).

Uses the repository's `geokernel-electron` package (GeoKernelViewer C API and its bundled
GDAL); requires Windows x64 and a valid GeoKernel license.

```powershell
npm install
npm run dsm-to-dtm-processing
```

Options follow the example name: `npm run dsm-to-dtm-processing -- --data-dir D:\cache`,
`--sample-archive <zip>` or `--sample-url <https-url>`. The default cache is
`outputs/data`, shared with the other DSM examples; all hash pins still apply.

## Workflow

1. Startup reuses the verified Zurich v2 sample and shows its original DSM. Nothing is
   converted until **Run DSM → DTM** is pressed.
2. Choose **Balanced**, **Remove more objects** or **Preserve more relief**, or edit the six
   parameters (working grid, max. window, base threshold, slope allowance, relief
   allowance, keep tolerance), then **Run**. The status bar shows the phase; **Cancel**
   keeps the last completed source/result.
3. The middle map shows the new DTM with the same hillshade as the original; the views are
   linked. With Pan active, click a pixel to read DSM, DTM, removed height, QA bits and the
   optional reference/error; a marker shows the cell on every map.
4. The right map shows **removed height** (0–20 m), **support / edge quality** or **signed
   reference error** (−2 to +2 m). Colours never clip the numeric results or scores.
5. Changing parameters keeps the last result on screen, marked as needing a new run; the
   summary and export keep the parameters actually used.
6. **Open DSM GeoTIFF** loads another source; **Open reference (optional)** attaches an
   exactly aligned evaluation raster and rescores without recomputing.
7. **Save result GeoTIFFs** writes `<name>.tif` (Float32 DTM), `.removed.tif`, `.qa.tif`
   (Byte QA bits 1/2/4/8/16) and `.json` (parameters, statistics, scores, provenance), each
   atomically. Source/reference paths are rejected; existing companions need confirmation.

## Method and results

Method `native-multiscale-morphological-tin-v1`: block-minimum lower envelope keeping each
minimum's real source pixel, reflected-boundary openings at doubling windows with a capped
base/slope allowance plus a DSM-derived relief allowance reduced in rough areas, GDAL linear
TIN gridding at the source pixel centres, a grid-support fallback outside the hull, source
retention within the keep tolerance and a DSM upper bound. The reference is never an input.

Grids are `Float32Array`s and the C++ float operations are rounded with `Math.fround`, so on
the Zurich sample the result is **identical to the Qt build** (DTM, removed heights and QA on
all 250,000 cells). Balanced: 10485 supports, 2582 hull-fallback pixels; RMSE 0.863 / MAE
0.324 / bias 0.200 m over all cells and 0.532 / 0.220 / 0.098 m outside the 32 m edge band.

Inputs: single-band north-up GeoTIFF, square pixels, projected metre CRS, metre heights,
8 × 8 to 4 million cells with at least 5% valid; working grid 3 × 3 to 262,144 cells.

## Implementation notes and differences from the Qt example

- Processing runs on Electron's main thread, which also pumps the native maps; long loops
  yield to the event loop every ~25 ms so the window, maps and **Cancel** stay responsive.
  GDAL's TIN construction is one native call and cannot be interrupted.
- Maps are hosted with the `dsm-to-dtm-profile` adapter ([map2d.js](../dsm-to-dtm-profile/map2d.js))
  and the launcher starts this example with Chromium hardware acceleration disabled
  (`NATIVE_2D_IN_PAGE` in the repository's `main.js`).
- The probe is a native overlay point that is moved, never removed (removal is deferred to
  a Qt event loop this host does not run). Views are linked by extent; each map adopts its
  first layer's CRS. Parameter fields accept any value in range; the step only sets the
  arrow increment, as in the Qt spin boxes.

Data: Federal Office of Topography swisstopo, 500 × 500 at 0.5 m, EPSG:2056, LN02 heights,
no vertical datum conversion. Fixed development crop, not a held-out benchmark.
