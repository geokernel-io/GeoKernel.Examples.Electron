# HOTOSM building footprints — Electron

HOTOSM DINOv3-S building footprint segmentation on the fixed buildings RGB raster.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run hotosm-building-footprints
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup downloads/verifies only the source archive and shows `buildings.tif`. No predictions are restored or generated until Run. The model is downloaded and prepared when Run is clicked; both assets are fixed and SHA-256 verified.

Building threshold defaults to **0.50**. The original 2503 × 1126 UInt8 RGB source is used without demo downsampling, retaining its EPSG:26911 coordinates and 0.6 m grid. Native inference uses the model mask, boundary and distance heads, with small-region filtering. At 0.50 the reference produces 636 building instances/polygons over 78 tiles. This is a reproducibility count, not an accuracy score; touching buildings and other model errors can remain.

The new result is a red polygon overlay with yellow outlines. Move the opacity slider right for a more opaque result. Save Shapefile opens a destination dialog; choose a new destination, since existing datasets are not overwritten. Source image and model stay cached; prediction files are temporary and are not loaded on later launches. There are no instance-label path controls or saved `building-labels.tif` outputs.

Input downloads/hash checks/ZIP extraction use a worker thread. Native inference runs as an asynchronous owned task. Export and release use asynchronous FFI. Electron continues pumping native viewer events. Cancel is cooperative. Rerun removes the previous overlay before releasing its workspace; close waits for worker, renderer and task cleanup before destroying the window.

Shared cache: `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` or `GEOKERNEL_EXAMPLES_DATA_DIR`. Existing verified .NET/Python assets are reused. Auto currently uses CPU; an explicit CUDA selection needs a matching GPU ONNX Runtime/CUDA/cuDNN deployment, without silent CPU fallback.

Retain HOTOSM CC-BY-4.0, separate Meta DINOv3 License, attribution and conversion notices. The sample imagery source/license remains unverified. See [data-sources.md](data-sources.md) for exact hashes and source details. Footprints are predictions, not ground truth or cadastral boundaries. No embedded license key, smoke mode or application test flags are included.

Display polygons are transformed to a temporary WGS84 GeoJSON in a worker so the viewer receives an explicit compatible CRS. Shapefile export retains the original projected task result. Building results start at 100% opacity with an opaque red brush and yellow outline. The slider applies opacity once at layer level, rather than multiplying brush alpha and layer opacity.
