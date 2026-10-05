# TerrainAnalysis — Electron

Automatically downloads and opens the Sagrada Família DEM. Uses the same native terrain relief, slope and aspect modes as Qt, WinForms, WPF and Python. Includes matching colour legends, 256/512/1024 mesh resolution, vertical exaggeration, native-load cancellation and camera reset.

Analysis describes loaded mesh faces before exaggeration, not an exported analysis raster. Mesh resolution affects results. Aspect is clockwise from north in local ENU, with eight sectors spanning ±22.5° and a flat class below 0.01°. Heights are metres with an unverified vertical reference.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

From **CMD**:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run terrain-analysis
```

The native viewer and Qt event pump remain on the main thread. The renderer uses a sandboxed preload bridge and validated IPC actions.
