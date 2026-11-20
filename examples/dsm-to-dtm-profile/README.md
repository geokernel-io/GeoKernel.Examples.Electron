# DSM to DTM — interactive elevation profile (Electron)

Electron port of the Qt `DsmToDtmProfile` example. Draw your own **A → B transect** on
two linked native GeoKernel **2D maps** placed over the page and compare the original
DSM, classical DTM, AI DTM and provider reference heights on one chart. **No inference
runs here.**

Uses the repository's `geokernel-electron` package (GeoKernelViewer C API and its
bundled GDAL); system GDAL, Python and model weights are not required. Requires Windows
x64 and a valid GeoKernel license.

```powershell
npm install
npm run dsm-to-dtm-profile
```

Options follow the example name: `npm run dsm-to-dtm-profile -- --data-dir D:\cache`,
`--sample-archive <zip>` or `--sample-url <https-url>`. All hash pins still apply. The
default cache is `outputs/data` (or `GEOKERNEL_EXAMPLES_DATA_DIR`), shared with
`dsm-to-dtm`.

## Workflow

1. Startup reuses the pinned Zurich v2 sample of `dsm-to-dtm` (archive and every file
   SHA-256 checked, [sample-assets.json](../dsm-to-dtm/sample-assets.json)) and validates
   the four numeric height rasters (500 × 500, 0.5 m, EPSG:2056).
2. The left map is always the original DSM; choose **Classical / AI / Reference** for
   the right map. Both maps share position and scale; pan or zoom either one.
3. The fixed transect loads initially. Choose **Draw transect**, click **A**, then **B**
   on either map. Dragging still pans; toggling Draw off cancels an unfinished line.
   Clicks outside the valid pixel centres are rejected; endpoints must be at least
   0.5 m apart.
4. The chart shows gray DSM, teal classical, purple AI and dashed orange reference;
   **Compare errors against reference** plots both estimates minus the reference.
5. Hovering over the chart marks the sample on both maps and lists its distance,
   coordinates and four heights. **Sample spacing** (0.5–10 m) resamples the line.
6. **Export profile CSV** writes the numeric samples and errors, then
   `<name>.csv.metadata.json`; each file atomically.
7. Cancel stops preparation; closing during loading cancels first, then releases both
   maps.

Profiles sample the Float32 arrays bilinearly between pixel centres (no extrapolation,
no datum conversion); RMSE/MAE describe this line only. Both maps use the same fixed
hillshade (azimuth 315°, altitude 40°), written as display-only RGB GeoTIFFs.

## Implementation notes and differences from the Qt example

- `geokernel-electron`'s `ViewerWindow` owns a separate top-level window, so
  [map2d.js](map2d.js) hosts each map like the WinForms control does: it creates a
  viewer through the package's public native loader (`createNativeLibrary`), reparents
  the viewer window into the BrowserWindow and places it over a page rectangle.
- The maps present through GDI, which Chromium's GPU compositor would cover, so the
  launcher starts this example with hardware acceleration disabled (`NATIVE_2D_IN_PAGE`
  in the repository's `main.js`). The page is light and renders well in software.
- The transect is drawn with the viewer's owned shapes; the hover sample is a native
  overlay point. A teal and B orange markers carry no letter tags, and the hover point
  is parked far outside the map instead of removed: the runtime removes text labels and
  overlay points with Qt's `deleteLater`, which never runs when the host pumps
  `GeoKernelViewer_ProcessEvents` instead of a Qt event loop, so removed items would
  reappear on the next view change.
- The viewer has no EPSG:2056 preset, so each map adopts the CRS of its first relief
  layer.
