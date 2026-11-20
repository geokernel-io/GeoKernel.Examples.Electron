# DSM to DTM — ground beneath buildings (Electron)

Electron port of the Qt `DsmToDtm` example. An original DSM stays visible beside a
prepared terrain estimate in two linked **native GeoKernel 3D** viewers placed over
the page. Choose the classical morphological/TIN or experimental DSM-only pix_grad
estimate and move the surface slider; heights are interpolated numerically between
both endpoints. **No inference runs here.**

Uses the repository's `geokernel-electron` package (Viewer3D C API and its bundled
GDAL); system GDAL, Python and model weights are not required. Requires Windows x64,
Vulkan and a valid GeoKernel license.

```powershell
npm install
npm run dsm-to-dtm
```

Options follow the example name: `npm run dsm-to-dtm -- --data-dir D:\cache`,
`--sample-archive <zip>` (exact local copy of the pinned ZIP) or
`--sample-url <https-url>` (mirror). All hash pins still apply. The default cache is
`outputs/data` or `GEOKERNEL_EXAMPLES_DATA_DIR`.

## Workflow

1. Startup downloads the fixed Zurich v2 sample from the `GeoKernel.SampleData` v1
   release. The ZIP and every extracted file are SHA-256 checked against
   [sample-assets.json](sample-assets.json); a complete valid cache works offline.
2. The left view always shows the original DSM; the right starts with the classical
   DTM at 100%. Pan, orbit or zoom either view; the other follows.
3. **0% is exactly the DSM, 100% exactly the selected DTM.** Intermediate values
   write a temporary Float32 GeoTIFF (`(1-t)*DSM+t*DTM`) and rebuild the right-hand
   terrain. Slider keyboard/drag changes use a short debounce.
4. The profile chart samples all four rasters on the fixed building transect: gray
   DSM, teal classical, purple AI, dashed orange reference.
5. Vertical exaggeration applies to both views. Cancel keeps the previous complete
   views and restores the last committed selection. Closing during preparation
   cancels first, then releases both viewers.

The reference DTM is used only for the profile and the stored crop scores.

## Differences from the Qt example

The published Viewer3D C API has no exact ENU camera mapping and no analysis-line
overlay. Render-space cameras are copied directly (both scenes share one grid and
grid-centre origin, so they correspond to within 1e-5), the transect is shown only
in the profile chart, and native terrain preparation shows an indeterminate
progress bar.

## Data

500 × 500 pixels at 0.5 m, EPSG:2056, heights in the source-declared LN02 reference
(EPSG:5728), no vertical datum conversion. Crop reference errors: classical RMSE
1.01 m / MAE 0.35 m, AI RMSE 0.66 m / MAE 0.41 m; not a held-out benchmark.
Data: **Federal Office of Topography swisstopo** (swissSURFACE3D Raster, swissALTI3D,
[OGD terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)).
AI: David Perez's [pix_grad checkpoint](https://doi.org/10.5281/zenodo.7973800),
CC BY 4.0; the archive contains derived output only, no weights.
