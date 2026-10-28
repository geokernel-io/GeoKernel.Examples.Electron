# SEN2SR super resolution — Electron

ESAOpenSR SEN2SRLite RGBN 4× super resolution on the fixed Sentinel-2 / FTW sample.

## SDK and launch

Uses the published **geokernel-electron 1.5.39** npm package, including its native runtime and Qt plugins. No sibling SDK source repository or local native build is needed.

From the repository root:

```powershell
npm install
npm run sen2sr-super-resolution
```

Models and sample inputs are downloaded automatically when needed. `GEOKERNEL_BIN` can explicitly select a compatible separately deployed runtime; the example does not select sibling source or native builds automatically.


## Workflow

Startup prepares only the source RGB display. Run prepares the fixed model and starts native background inference. No predictions are loaded at startup or saved automatically. The original raw TIFF and model package are downloaded, SHA-256 checked and cached when needed.

Input is the unchanged 578 × 379 eight-band FTW TIFF. Inference uses only its first RGB + NIR period: B4/B3/B2/B8. Radiometric correction/normalization is embedded in the model package; do not pre-scale the scientific input. The source display uses the first four bands for validity and a 2–98% RGB stretch, prepared on a worker using SDK GDAL/Koffi. No Python, rasterio or PyTorch dependency is added.

The result is 2312 × 1516 with four Float32 reflectance bands, computed over 28 overlapping tiles. The reference matches the native/Qt result pixel-for-pixel in all four bands. This verifies reproducibility, not accuracy. Estimated detail on a finer grid is not a new sensor measurement; evaluate downstream measurements or detection separately.

After inference, native source and enhanced RGB comparison images use the same contrast stretch. Move Enhanced opacity left to see the source and right to see the enhanced image. These are display-only previews; Save GeoTIFF retains the scientific RGB + NIR output.

Save GeoTIFF opens a destination dialog. Choose a new destination; existing datasets are not overwritten. The output retains source CRS/origin/footprint, divides affine pixel/rotation terms by four, and records AI provenance. Band 4 is NIR, not alpha. Float reflectance is not display-clipped. There is no Shapefile export.

Downloads, hash checks, extraction and initial RGB preparation use a worker. Inference is an asynchronous native task; export/release use asynchronous FFI while Electron pumps native viewer events. Cancel is cooperative. Rerun detaches both job-owned comparison previews and restores the persistent cached source before releasing the old workspace. Close waits for worker, renderer and task cleanup.

Inputs share `%LOCALAPPDATA%/GeoKernel/Examples/GeoAI` or `GEOKERNEL_EXAMPLES_DATA_DIR`; predictions remain temporary until explicitly exported. Auto currently selects CPU. Explicit CUDA requires matching GPU ONNX Runtime/CUDA/cuDNN files, without silent CPU fallback. The native task rejects invalid/unsupported spectral inputs and limits scientific output memory to 512 MiB.

Retain CC0-1.0 and inherited Apache-2.0 package notices. See [data-sources.md](data-sources.md) for exact model/source revisions, hashes, attribution and imagery caveats. No embedded license keys, smoke modes or application test flags are included.
