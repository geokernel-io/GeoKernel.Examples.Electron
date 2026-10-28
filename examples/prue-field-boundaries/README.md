# PRUE field boundaries — Electron

Fields of The World / PRUE EfficientNet-B5 CC-BY field segmentation on the pinned Sentinel-2 sample.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run prue-field-boundaries
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup downloads/verifies the fixed spectral input and displays a separately prepared first-period RGB image. No predictions are loaded. Run prepares the fixed model and starts native background segmentation. Results stay temporary until explicitly exported.

Input is a raw TIFF downloaded directly from a pinned upstream commit, not a ZIP. The original 578 × 379 eight-band Float32 stack is preserved: B4_B/B3_B/B2_B/B8_B followed by B4_A/B3_A/B2_A/B8_A. These are L2A DN values with normalization embedded in ONNX; do not pre-scale the source.

An asset worker uses SDK GDAL through Koffi to prepare a first-period RGB display, a 2–98% channel stretch and validity from all eight bands. Source CRS, affine and scientific pixels are preserved. This adds no rasterio/Python/PyTorch dependency. Only inputs and their derived display are cached.

The preview shows background class 0, field interior class 1 and boundary class 2. NoData -1 is transparent. Save Shapefile opens a destination dialog and exports only class-1 field interiors. Choose a new destination; existing datasets are not overwritten. The reference gives 259 field-interior polygons over two tiles. This is a reproducibility check, not an accuracy score. Image-derived agricultural divisions are not legal/cadastral parcels.

Move the opacity slider right for a more opaque result. Downloads, hashes, extraction and RGB preparation use a worker thread; inference uses an asynchronous native job. Export and release use asynchronous FFI while Electron pumps native viewer events. Cancel is cooperative. Rerun detaches the old overlay before releasing its workspace; close waits for worker, renderer and task cleanup.

Shared input cache: `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` or `GEOKERNEL_EXAMPLES_DATA_DIR`. Existing verified .NET/Python input files are reused. Auto currently uses CPU; explicit CUDA requires a compatible GPU ONNX Runtime/CUDA/cuDNN deployment without silent CPU fallback.

Retain model weight CC-BY-4.0, upstream MIT, attribution and conversion notices. The FULL model variant is not used. See [data-sources.md](data-sources.md) for exact URLs, hashes, band order and attribution. No embedded license key, smoke mode or application test flags are included.

PRUE model v2 uses the same CCBY checkpoint at native resolution with 384 × 384 tiles and 128-pixel overlap. It requires SDK 1.5.39. Larger context reduces the rectangular top-left omission in this sample; this is a visual regression check, not a general accuracy benchmark. Model v1 remains available under its original URL.
