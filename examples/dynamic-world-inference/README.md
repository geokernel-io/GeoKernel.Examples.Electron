# Dynamic World inference — Electron

Google Dynamic World nine-class land-cover classification on the fixed Spain Sentinel-2 L1C sample.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run dynamic-world-inference
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup prepares only the source imagery and displays its RGB preview. No predictions are loaded. Run downloads/verifies the fixed model and starts native background classification. The reference gives 1400 polygons; this is a reproducibility check, not an accuracy score.

The opacity slider becomes more opaque to the right. It controls the new prediction at native layer index 0. Save Shapefile opens the destination dialog and exports all valid land-cover classes, including water class 0. Choose a new destination; existing datasets are not overwritten. NoData is excluded and transparent.

Input is the original nine-band L1C DN stack at 512 × 512, 10 m, EPSG:32630. ONNX embeds the required normalization; do not pre-scale the input. The validity raster marks observed pixels and is not a cloud/shadow mask. The RGB display is separate from inference input. Class names and attribution appear in diagnostics.

Model/input downloads, SHA-256 checks and ZIP extraction run in a worker thread. Native inference uses an owned asynchronous job. Explicit export and task release use asynchronous FFI. The Electron event loop keeps pumping native viewer events. Cancel is cooperative; close cancels pending work, detaches layers and waits for renderer/job cleanup before destroying the window.

Inputs share `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` with .NET/Python, or `GEOKERNEL_EXAMPLES_DATA_DIR`. ZIPs are hash-verified, extracted through a temporary directory and checked for unsafe paths. Interrupted partial downloads are removed. Results remain temporary for the session and are never restored automatically.

Auto currently selects CPU. Explicit CUDA requires a compatible GPU ONNX Runtime/CUDA/cuDNN deployment. This example does not install GPU files or silently fall back from an explicit CUDA selection.

Keep model Apache-2.0 notices and **Contains modified Copernicus Sentinel data 2019** imagery attribution. Full URLs, hashes, band order, acquisition metadata and license notices are in [data-sources.md](data-sources.md). No embedded license keys, smoke modes or application test flags are included.
