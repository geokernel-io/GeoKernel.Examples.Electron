# PointCloudViewer — Electron

Downloads and opens the EuroSDR P4 40 × 40 m LAZ sample automatically. Uses the same native LAS/LAZ reader and point-preview renderer as the Qt, WinForms, WPF and Python examples.

Controls: RGB/height colours, 50,000 / 100,000 / 250,000 display sample limits, cancel native loading and reset view. Source count, display count, Z range and RGB availability are shown. Cancellation/read failure retains the previous cloud. Download/extraction uses the repository's shared cache helper; cancellation is enabled during native reading.

Source coordinates remain EPSG:32630 with provisional heights. This is a locally normalized preview; source data is not modified. Point size is fixed at one pixel.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

Run from **CMD**:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run point-cloud-viewer
```

Native calls and the Qt event pump stay on Electron's main thread. The renderer uses a sandboxed preload bridge with context isolation and validated IPC actions.
