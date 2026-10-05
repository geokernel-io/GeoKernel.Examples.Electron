# ElevationProfile — Electron

Automatically downloads and opens the Sagrada Família DEM and orthophoto. Click terrain to draw a route and view the elevation profile below the native viewport. Includes finish, undo, clear, sampling interval, ascent/descent totals, imagery visibility and vertical exaggeration.

Uses the same native profile API as Qt, .NET and Python: up to 64 route points and 4096 samples, processed incrementally. Results describe the loaded terrain mesh with an unverified source vertical datum. Missing elevations remain gaps. Display exaggeration does not change measurements.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

From CMD:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run elevation-profile
```

The native viewport reserves 240 logical pixels at the bottom for the chart. Native calls stay on the main thread; the sandboxed renderer uses a restricted preload bridge and validated IPC actions.
