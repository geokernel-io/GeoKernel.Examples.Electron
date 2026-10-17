# GlobeVectorStyling — Electron

Real Sagrada Familia building footprints over Esri satellite imagery, with
atmosphere and the same oblique camera as the Qt, WinForms, WPF and Python samples.

From the repository root:

```powershell
npm install
npm run globe-vector-styling
```

Uses the published `geokernel-electron@1.5.35` package and its automatically
installed native SDK. Requires Windows x64, a Vulkan-capable graphics driver
and a valid license. The first launch downloads the real building shapefile
from GeoKernel.SampleData and caches it under `outputs/data/sagrada_familia_buildings`.
Internet is required for the initial download and Esri imagery.

Controls: Fill, Labels, Color by (source field or Uniform), label field,
opacity, base color, Zoom to buildings, and Esri on/off. Click a building to
display its attributes; hover the status text to read long values. Polygons
rejected by SDK fill validation remain outline-only; the status reports their count.

Includes the application icon and a fixed 24-pixel status bar. Load and style
operations use asynchronous SDK jobs. The native Globe closes before its parent
window. The Qt/Windows C runtime PATH synchronization from GlobeHello is retained.
There are no application test modes or additional command-line options.
