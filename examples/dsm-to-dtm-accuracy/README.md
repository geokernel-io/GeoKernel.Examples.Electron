# DSM to DTM — reference accuracy by area (Electron)

Electron port of the Qt `DsmToDtmAccuracy` example: compare **where classical and AI
terrain estimates differ from the same reference**. Three linked native GeoKernel **2D
maps** placed over the page keep the original DSM on the left, with classical and AI
error maps beside it on one shared colour scale. Select an area to compare numeric
errors, their distribution and individual source pixels. **No inference runs here.**

Uses the repository's `geokernel-electron` package (GeoKernelViewer C API and its
bundled GDAL); requires Windows x64 and a valid GeoKernel license.

```powershell
npm install
npm run dsm-to-dtm-accuracy
```

Options follow the example name: `npm run dsm-to-dtm-accuracy -- --data-dir D:\cache`,
`--sample-archive <zip>` or `--sample-url <https-url>`. The default cache is
`outputs/data`, shared with the other DSM examples; all hash pins still apply.

## Workflow

1. Startup reuses the verified Zurich v2 sample and prepares 19 shared-scale Byte RGB
   display maps (DSM relief; per method 4 signed, 4 absolute and 1 terrain relief).
2. **Signed reference errors** (blue below, white zero, red above), **Absolute reference
   errors** or **Terrain estimates**. **Display limit** (1, 2, 5, 10 m) only sets colour
   saturation; scores never change with colours or zoom.
3. Choose a geographic preset or **Select evaluation area** and drag a box on any map.
   Both methods are evaluated on the same source cells; cells outside are dimmed on all
   maps. **Evaluate current view** and **Full sample** set the area directly.
4. The table lists RMSE, MAE, bias, nearest-rank P95 of |error| and the share above
   **Large error >**; the sidebar names the lower RMSE and lower MAE separately (no
   overall winner). The histogram shows six absolute-error bins as percentages.
5. With Pan active, click a pixel to read DSM, reference, classical and AI heights and
   both signed errors; a marker shows the cell on every map.
6. **Export area report** writes JSON metrics, histogram counts, threshold, pixel window,
   cell bounds, manifest, archive hash and attribution, atomically.

Full sample: classical RMSE 1.006692 / MAE 0.350048 / bias 0.247517 m; AI RMSE 0.659430 /
MAE 0.406952 / bias −0.277471 m. Presets are geographic windows, not land-cover classes.

## Implementation notes and differences from the Qt example

- Maps are hosted with the `dsm-to-dtm-profile` adapter ([map2d.js](../dsm-to-dtm-profile/map2d.js))
  and the launcher starts this example with Chromium hardware acceleration disabled
  (`NATIVE_2D_IN_PAGE` in the repository's `main.js`), because the GPU compositor would
  cover the GDI-presented maps.
- The area is drawn with the viewer's owned shapes: four translucent rectangles dim the
  outside, a solid outline marks the evaluated cells. The probe is a native overlay point
  that is moved, never removed (removal is deferred to a Qt event loop this host does
  not run). Views are linked by extent; each map adopts its first layer's CRS.
