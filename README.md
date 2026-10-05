# GeoKernel Electron Examples

Official Electron and JavaScript examples for the GeoKernel native GIS SDK.

## Requirements

- Windows 10 or later
- Node.js and npm
- A valid GeoKernel license

## Getting Started

Choose an example directory, install its dependencies with `npm install` and run it using the included npm scripts.

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

The example uses the published `geokernel-electron@1.5.32` package. No local SDK build is required.

## Buildings3D

Run `npm run buildings-3d`. The sample automatically downloads the Sagrada
Família DEM, orthophoto and building footprints. Buildings are clamped to the
terrain, with an illustrative default height of 9 metres. Change the height
and select **Apply height / Reload sample**. Visibility, color, opacity and
terrain exaggeration are also adjustable.

The example uses the published `geokernel-electron@1.5.32` package. No local SDK build is required.

## ModelPlacement

Run `npm run model-placement`. The example automatically downloads the textured
Sagrada Família model, DEM, orthophoto and EGM08D595 geoid grid. Longitude,
latitude, height above terrain, heading, pitch, roll and scale can be changed
with **Apply placement / Reload**. Model visibility, imagery, focus and terrain
exaggeration controls are included. No placeholder model is displayed.

The example uses the published `geokernel-electron@1.5.32` package. No local SDK build is required.
Placement is approximate. The model download retains its source and license.

## ViewshedAnalysis

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

## LayerStylingAndFiltering

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

## ProjectSaveLoad

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.