# Prithvi flood analysis — Electron

IBM/NASA Prithvi EO 2.0 300M-TL Sen1Floods11 water/flood mapping on the fixed India Sentinel-2 sample.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run prithvi-flood-analysis
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup downloads/verifies the fixed input archive, prepares a separate RGB display, and shows only the source. Run prepares the fixed model and starts native background inference. No predictions are loaded at startup or saved automatically.

The scientific input remains the original 512 × 512 thirteen-band Sentinel-2 L1C chip. Inference selects B2/B3/B4/B8A/B11/B12 (bands 2/3/4/9/12/13). Normalization is embedded in the ONNX package. Do not additionally scale input values. The native task also accepts a compatible preselected six-band stack.

An asset worker uses SDK GDAL through Koffi to create a B4/B3/B2 RGB display, with a 2–98% per-channel stretch and alpha for invalid pixels. CRS and affine are preserved. It opens the scientific source read-only and adds no rasterio/Python/PyTorch dependency. Only this derived source display is cached; predictions stay temporary.

The raster preview shows non-water class 0 and water/flood class 1; invalid class -1 is transparent. Save Shapefile opens a destination dialog and exports only water/flood polygons. Choose a new destination; existing datasets are not overwritten. The reference produces 57 polygons over nine tiles, with 139744 non-water pixels and 122400 water pixels. This verifies reproducibility, not accuracy. A single image cannot distinguish permanent water from newly flooded land.

Move the opacity slider right for a more opaque prediction. Downloads, hashes, extraction and RGB preparation use a worker thread. Native inference is asynchronous; export and release use asynchronous FFI. Electron keeps pumping native viewer events. Cancel is cooperative and may wait for loading or the current tile. Model loading has a multi-GB working set. Close waits for worker, renderer and task cleanup; rerun detaches previous results before releasing their workspace.

Inputs share `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` or `GEOKERNEL_EXAMPLES_DATA_DIR`. Existing verified .NET/Python archives are reused. Auto currently uses CPU. Explicit CUDA requires a compatible GPU ONNX Runtime/CUDA/cuDNN deployment, without silent CPU fallback.

Retain Apache-2.0 model notices and source imagery attribution. The processed dataset's redistribution provenance must be considered separately from the model license. See [data-sources.md](data-sources.md) for URLs, hashes and license details. No embedded license key, smoke mode or application test flags are included.
