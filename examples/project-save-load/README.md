# ProjectSaveLoad — Electron

Automatically loads Sagrada Família terrain, orthophoto, roads and buildings.
Includes the existing layer styling/filtering panel, Open, Save and Save as.
Ctrl+S / Ctrl+Shift+S work while the HTML control panel has focus.

Uses the same native .gk3d reader/writer as Qt, .NET and Python. Saves local source
references, camera, vertical exaggeration, visibility, opacity, colors, themes
and filters. Pending filter text is applied before saving. Files are not embedded;
keep the data cache and referenced sources accessible. Open/reload replaces the
scene. Cancelled or failed preparation retains the previous scene.

The sample supports local DEM/imagery/roads/buildings projects. Advanced model,
point-cloud, 3D Tiles, globe, analysis, time-series and geoid-conversion projects
are rejected by the shared native bridge.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

Run from CMD:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run project-save-load
```
