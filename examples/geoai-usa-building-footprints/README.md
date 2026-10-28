# GeoAI USA building footprints — Electron

USA-trained Mask R-CNN ResNet50 FPN building extraction on the fixed buildings RGB sample.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run geoai-usa-building-footprints
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup downloads/verifies the fixed source archive and shows only `buildings.tif`. Run prepares the fixed model and starts background instance segmentation. No predictions are loaded at startup or saved automatically.

Confidence threshold defaults to **0.50**. The model mask threshold remains 0.50 and NMS IoU 0.50; the confidence control does not change those settings. Original RGB bands and 2503 × 1126 source pixels are preserved, with EPSG:26911 and a 0.6 m grid. Native inference uses 512px tiles with 128px overlap and filters masks smaller than 16 pixels.

The reference is 746 building instances and 857 polygon features over 21 tiles. Instances can have disconnected polygon parts, so these counts need not match. This is a reproducibility check, not an accuracy score. The checkpoint is USA-trained and does not guarantee equivalent performance in other regions.

Results are red polygons with yellow outlines. Move the opacity slider right for a more opaque result. Save Shapefile opens a destination dialog; choose a new destination, since existing datasets are not overwritten. There are no instance-label path controls or saved `building-labels.tif` outputs. Predictions remain temporary until explicitly exported.

Download, hash verification and ZIP extraction use a worker thread. Native inference owns an asynchronous task. Export/release use asynchronous FFI, while Electron keeps pumping native viewer events. Cancel is cooperative. Rerun detaches the previous overlay before releasing its workspace; close waits for worker, renderer and task cleanup.

The shared input cache is `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` or `GEOKERNEL_EXAMPLES_DATA_DIR`. Existing verified .NET/Python assets are reused. Auto currently uses CPU; explicit CUDA requires a compatible GPU ONNX Runtime/CUDA/cuDNN deployment, without silent CPU fallback.

The existing ONNX graph may emit internal dynamic-mask shape warnings. These remain visible in the runtime logs; the reference output is separately checked. Other runtime errors are reported in diagnostics.

Retain the package MIT model declaration, attribution and conversion notices. Imagery source/license is unverified. See [data-sources.md](data-sources.md) for exact URLs, hashes and provenance. Predicted footprints are not ground truth or cadastral boundaries. No embedded license key, smoke mode or application test flags are included.

Display polygons are transformed to a temporary WGS84 GeoJSON in a worker so the viewer receives an explicit compatible CRS. Shapefile export retains the original projected task result. Building results start at 100% opacity with an opaque red brush and yellow outline. The slider applies opacity once at layer level, rather than multiplying brush alpha and layer opacity.
