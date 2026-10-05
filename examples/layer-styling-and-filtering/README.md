# LayerStylingAndFiltering — Electron

Automatically downloads the Sagrada Família DEM, orthophoto, roads and buildings
using the shared sample cache. Supports per-layer visibility, opacity, source or
uniform colors, attribute themes, literal case-insensitive substring filters,
example values, matching counts and zoom to matching features.

Uses the same native ViewerController operations as Qt, .NET and Python.
Filtering affects drawing and selection; counts include nondrawable source records.
Example values are limited to 200 per field, but filters search all records.
Changes are session-only. Building heights are illustrative (9 m).
The DEM vertical datum is unverified.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

From CMD:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run layer-styling-and-filtering
```

All SDK calls remain on the main thread. The sandboxed renderer uses validated IPC.
The 280px control panel matches the existing native host offset.
