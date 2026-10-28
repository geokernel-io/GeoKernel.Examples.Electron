# GeoKernel Electron Examples

Official Electron and JavaScript examples for the GeoKernel native GIS SDK.

## Requirements

- Windows 10 or later
- Node.js and npm
- A valid GeoKernel license

## Getting Started

From the repository root, install dependencies with `npm install` and run an example using its npm script.

## Resources

- [GeoKernel Website](https://geokernel.io)
- [Documentation](https://docs.geokernel.io)
- [Sample Data](https://github.com/geokernel-io/GeoKernel.SampleData)

## Support

For questions, contact [admin@geokernel.io](mailto:admin@geokernel.io).

## RoadsOnTerrain

Run `npm run roads-on-terrain`. The sample automatically downloads the Sagrada
Família DEM, orthophoto and roads. Controls include road visibility, color,
opacity, terrain resolution and vertical exaggeration.

The example uses the published `geokernel-electron@1.5.39` package. No local SDK build is required.

## Buildings3D

Run `npm run buildings-3d`. The sample automatically downloads the Sagrada
Família DEM, orthophoto and building footprints. Buildings are clamped to the
terrain, with an illustrative default height of 9 metres. Change the height
and select **Apply height / Reload sample**. Visibility, color, opacity and
terrain exaggeration are also adjustable.

The example uses the published `geokernel-electron@1.5.39` package. No local SDK build is required.

## ModelPlacement

Run `npm run model-placement`. The example automatically downloads the textured
Sagrada Família model, DEM, orthophoto and EGM08D595 geoid grid. Longitude,
latitude, height above terrain, heading, pitch, roll and scale can be changed
with **Apply placement / Reload**. Model visibility, imagery, focus and terrain
exaggeration controls are included. No placeholder model is displayed.

The example uses the published `geokernel-electron@1.5.39` package. No local SDK build is required.
Placement is approximate. The model download retains its source and license.

## ViewshedAnalysis

Uses the published GeoKernel 1.5.39 package. No local SDK build or DLL override is required.

## LayerStylingAndFiltering

Uses the published GeoKernel 1.5.39 package. No local SDK build or DLL override is required.

## ProjectSaveLoad

Uses the published GeoKernel 1.5.39 package. No local SDK build or DLL override is required.
## GlobeHello

```powershell
npm install
npm run globe-hello
```

Uses the published `geokernel-electron@1.5.39` package, including its native
runtime. No local SDK build or manual DLL copying is required. Windows x64
and a Vulkan-capable graphics driver are required for this embedded example.

The globe starts with Atmosphere, Esri Satellite, DEM and Sunlight switched
off, matching the Qt, WinForms, WPF and Python GlobeHello examples. Enable
each independently using the toolbar. Esri imagery and elevation are streamed
on demand and require an internet connection. Attribution and runtime errors
appear in a fixed-height status bar.

Left drag pans; right drag or the wheel zooms; middle drag or Ctrl-drag orbits.
The window uses the shared application icon and disposes the native Globe
before its parent closes. No application test modes are included.

## GlobeTerrainNavigation

Run `npm run globe-terrain-navigation` from the repository root. Opens above
Barcelona with real Esri imagery, DEM, atmosphere and sunlight. Includes nine
camera controls, four feature toggles, the application icon and fixed-height
status bar. Uses the published 1.5.39 package and the GlobeHello TLS path fix.
See [example instructions](examples/globe-terrain-navigation/README.md).

## GlobeVectorStyling

[GlobeVectorStyling](examples/globe-vector-styling/README.md) downloads real Sagrada
Familia buildings and displays them over Esri imagery. Includes attribute colors,
fills, labels, opacity, base color, camera reset and identification. Uses the
published SDK 1.5.39 with automatic installation.

~~~powershell
npm run globe-vector-styling
~~~

## GlobeBuildings (Electron)

Displays real Sagrada Familia building footprints over Esri imagery with atmosphere.
The published `geokernel-electron` 1.5.39 SDK installs through `npm install`; the
building sample downloads automatically and is cached in `outputs/data`.

```powershell
npm install
npm run globe-buildings
```

Click Extrude to switch between footprints and 3D buildings. Display height defaults
to 18 metres and is illustrative, not measured. Disable extrusion before changing
height (1–300 metres). Like the Qt example, building bases use the reference sphere
without DEM. Controls stay disabled until geometry generation and GPU upload finish.

Includes Zoom to buildings, Atmosphere and Esri toggles, the shared application icon,
a fixed 24-pixel status bar, and native cleanup on close. Requires Windows x64,
a Vulkan-capable graphics driver, a valid license and internet for the first data
download and imagery. Uses the same native DLL search-path setup as GlobeHello.
No diagnostics or smoke-test modes are included.

## GlobeModelPlacement (Electron)

Displays the real Sagrada Familia glTF model with Esri imagery and atmosphere,
using published `geokernel-electron` 1.5.39. The shared sample-data helper downloads
and extracts the model, buffers and textures on first launch and reuses the
`outputs/data/sagrada_familia_3d_model` cache afterward.

```powershell
npm install
npm run globe-model-placement
```

Matches Qt's approximate placement at longitude 2.1744 / latitude 41.4036,
ellipsoidal anchor height 14.089 m, without DEM. Model credit: PeeJaa.
Controls include Zoom to model, Rotate 30 degrees, Scale (0.01–10), Anchor height
(-100–10000 m), Apply, Remove, Restore, Atmosphere and Esri. Change scale/height
and click Apply. Restore reloads the cached model with its last accepted placement.
Controls remain disabled until geometry generation and GPU upload complete.

Includes the shared icon, fixed 24-pixel status bar, native resource cleanup,
and GlobeHello's native DLL search-path fix. No diagnostics or smoke-test modes.
Requires Windows x64, a Vulkan-capable graphics driver, a valid license and
internet for initial downloads and satellite imagery.

Known SDK 1.5.38 limitation: heading 30 degrees with scale 1.5 is rejected with
`Model is too small for scene precision.` Scale 2 succeeds. The example displays
the error and restores accepted input values while retaining the previous model.
This native precision limitation requires a separate SDK fix/release.

## GlobeRasterServices (Electron)

Opens real Sagrada Familia orthophoto and DEM with Esri imagery and atmosphere.
Both local layers start enabled with elevation exaggeration 1x. DEM color shading
is explicitly disabled so it does not cover the aerial photograph. No service
selection buttons or synthetic raster data are included.

```powershell
npm install
npm run globe-raster-services
```

Uses published `geokernel-electron` 1.5.39. The shared sample-data helper automatically
downloads and extracts the GeoTIFF archives on first launch, then reuses
`outputs/data/sagrada_familia_ortophoto` and `outputs/data/sagrada_familia_terrain`.
Loading uses asynchronous SDK jobs. Includes the shared icon, fixed 24-pixel status
bar, runtime error reporting and native cleanup on close. The GlobeHello native
DLL search-path fix is preserved. No diagnostics or smoke-test modes are included.

Requires Windows x64, a Vulkan-capable graphics driver, a valid license and internet
for initial downloads and satellite imagery.

## Globe terrain analysis

Run `npm run globe-terrain-analysis` with the published GeoKernel SDK 1.5.39.
The example downloads and caches the real Sagrada Familia DEM automatically,
opens Barcelona with Esri imagery and atmosphere, and keeps DEM color shading off.

Select Line of sight or Measure and click two terrain points; select Viewshed or
Slope / aspect and click one point. A new click starts another selection after
results are shown. Drag to navigate, Esc to cancel, Clear to remove results, and
Barcelona to restore the camera. Results remain in a fixed 170-pixel panel.

Line of sight uses observer and target heights of 1.7 m and accepts targets within
10 km. Viewshed uses a 350 m radius and 15 m sample spacing. These analyses use
terrain only, excluding buildings. The sight line drawn on the map marks the
ground path rather than the elevated ray. If terrain changes during calculation,
the result is marked stale; wait for loading to settle and select again.


## Native AI task examples — published SDK 1.5.39

- [Dynamic World inference](examples/dynamic-world-inference/README.md): `npm run dynamic-world-inference`; fixed Sentinel-2 input, native background classification, opacity slider and explicit Shapefile export.

- [HOTOSM building footprints](examples/hotosm-building-footprints/README.md): `npm run hotosm-building-footprints`; fixed RGB source, threshold 0.50, building overlays and explicit Shapefile export.

- [GeoAI USA building footprints](examples/geoai-usa-building-footprints/README.md): `npm run geoai-usa-building-footprints`; Mask R-CNN, confidence threshold 0.50 and explicit Shapefile export.

- [Prithvi flood analysis](examples/prithvi-flood-analysis/README.md): `npm run prithvi-flood-analysis`; original spectral input, worker RGB display and water-only Shapefile export.

- [PRUE field boundaries](examples/prue-field-boundaries/README.md): `npm run prue-field-boundaries`; two-period eight-band input, worker RGB display and field-interior Shapefile export.

These workflows use geokernel-electron 1.5.39 from npm, including its native runtime. Run npm install once, then use the commands above. Model and sample downloads are verified and cached automatically.

- [SAM3 segmentation](examples/sam3-segmentation-inference/README.md): `npm run sam3-segmentation-inference`; text/point/box prompts, draft acceptance and Shapefile/GeoTIFF export.
- [SEN2SR super resolution](examples/sen2sr-super-resolution/README.md): `npm run sen2sr-super-resolution`; shared-contrast comparison and four-band Float32 GeoTIFF export.
