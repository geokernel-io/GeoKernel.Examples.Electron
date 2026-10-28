# SAM3 segmentation — Electron

Meta SAM3 text and interactive point/box segmentation on the fixed buildings raster.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run sam3-segmentation-inference
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup displays only the fixed RGB source. Generate draft prepares only the selected model profile and starts asynchronous inference. Text segmentation scans the source using a concept such as `building`, with text score threshold 0.50 by default. Text mode ignores map points and boxes.

Point / box segmentation uses the separate tracker. Choose Positive point, Negative point or Box: click two corners. Points appear green/red and boxes yellow. A positive point or a completed box is required; negative-only prompts are rejected. A box surrounds one object and does not detect all buildings in an area. Clear prompts removes selections. Up to 64 point/box tokens are allowed; a box consumes two.

The display map is WGS84. SDK GDAL transforms points and all four box corners to the original raster CRS on a worker, with traditional GIS axis order. The original raster is not reprojected/resampled for inference. Tracker quality selection is separate from the text score threshold.

Review orange draft polygons. Accept draft enables explicit Save Shapefile and Save accepted GeoTIFF dialogs. Discard removes the temporary result and allows another generation. GeoTIFF pixels contain instance IDs, not semantic classes or confidence. Choose a new destination; existing datasets are not overwritten. No predictions are restored at startup.

The opacity slider becomes more opaque to the right. Inputs are shared in `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` or `GEOKERNEL_EXAMPLES_DATA_DIR`. SHA-256 checks, downloads, extraction and coordinate preparation run on a worker. SAM3 ZIPs use lazy streaming/ZIP64 extraction; neither the archive nor a complete model file is buffered into JS memory. Both profiles use the specialized `sam3-package.json` manifest and native bundle validation.

Text is approximately 3.09 GB and tracker 1.70 GB. Only the selected profile is downloaded; extracted model files need additional disk space. Results remain temporary until saved. Native inference is asynchronous; export/release use asynchronous FFI. Cancel is cooperative and may wait for model loading/current inference. Close waits for worker, renderer and task cleanup before destroying the window.

Auto currently selects CPU. CUDA requires a compatible GPU ONNX Runtime, CUDA/cuDNN deployment and sufficient GPU memory. Set `GEOKERNEL_BIN` to that deployment. Selecting CUDA does not install GPU files or silently fall back to CPU.

Retain the SAM License and package notices. See [data-sources.md](data-sources.md) for hashes, source details and the sample imagery licensing caveat. No embedded license key, smoke mode or application test flags are included.
