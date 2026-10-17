# GlobeTerrainNavigation

Run from the repository root:

```powershell
npm install
npm run globe-terrain-navigation
```

Uses the published `geokernel-electron@1.5.35` package and its native runtime.
Requires Windows x64, a Vulkan-capable graphics driver and a valid license.
No local SDK build or manual DLL copying is required.

Opens above Sagrada Familia in Barcelona with Esri satellite imagery, streamed
DEM, atmosphere and sunlight enabled. Toggle the four features independently.
Imagery and elevation require internet access; no synthetic data is used.

The second toolbar provides zoom, rotation, tilt, top view, north alignment and
Overview. Overview returns to the same camera as the Qt, WinForms, WPF and Python
examples: longitude 2.1744, latitude 41.4036, target height 40 m, distance 2500 m,
pitch approximately 37.24 degrees.

Left drag pans; right drag or the wheel zooms; middle drag / Ctrl + left drag
orbits. Includes the shared application icon and fixed 24-pixel status bar.
Native resources are released before the parent window closes.

The Windows C runtime's DLL search path is synchronized with the SDK path before
Qt initialization, retaining the GlobeHello TLS fix. No diagnostics or application
test modes are included.
