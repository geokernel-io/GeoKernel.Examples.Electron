# Tiles3DStreaming — Electron

Automatically downloads Sagrada Família DEM, orthophoto, 3D Tiles and EGM08D595.
Uses the same native camera-driven streamer as Qt and the other language examples.
Includes geometry budget, start/stop, visibility, focus and live diagnostics.
Vertical exaggeration remains 1×. Alignment is approximate; cache counters are not
total RAM/VRAM. Stop retains tiles; hiding clears them and showing restarts.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run tiles-3d-streaming
```

Native calls remain on the main thread. State is copied every 500 ms and only
changed snapshots cross IPC to the isolated renderer.
