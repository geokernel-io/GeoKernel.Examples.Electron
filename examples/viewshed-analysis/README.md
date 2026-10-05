# ViewshedAnalysis — Electron

Automatically downloads and opens the Sagrada Família DEM and orthophoto. Select an observer on terrain, adjust eye/target heights, radius, ray spacing and grid resolution, then calculate visibility. Includes pause/resume, clear, imagery and overlay visibility, and vertical exaggeration.

Results appear in a north-up grid and as a 55%-opacity overlay on the 3D terrain. Uses the same native calculation and triangle-clipped overlay as Qt, .NET and Python. Changing analysis settings invalidates the previous result.

Analysis samples the loaded 512-sample terrain mesh; buildings, vegetation and refraction are excluded. Small obstacles between samples may be missed. The vertical datum is unverified. Exaggeration changes only the view.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

From CMD:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run viewshed-analysis
```

Native calls stay on the main thread. The sandboxed renderer uses a restricted preload bridge and validated IPC actions. Downloads use the existing shared cache helper.
