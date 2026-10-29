# Building change review — Electron

Oosterwold 2016 → 2025, using two synchronized native GeoKernel map panes and
the standard native control panel. Analyze, select candidates, edit vertices,
review and export approved GeoJSON. No browser-based map or local SDK build is used.

Requires Windows x64, Node.js/npm, a supported graphics driver and a valid
GeoKernel license. Uses published `geokernel-electron@1.5.39`; GDAL/ONNX and
native viewing come from that package. From the repository root:

```powershell
npm install
npm run building-change-review
```

## Workflow

Startup downloads/verifies imagery and model and displays the two source dates.
Map previews are reprojected to WGS84 in a worker using the SDK's GDAL runtime;
analysis retains the original EPSG:25831 rasters. Loading errors are shown in
the status bar; **Run analysis** retries loading if preparation failed.
Choose **Demo area (fixed)** (320 m square), **Current view**, or **Full dataset**
(1024 m square), then **Run analysis**. CPU and threshold **0.4371** are the defaults.
Use the **Candidate** dropdown to select and **Locate** to center both maps.

Green denotes additions, red removals, gray rejected candidates. Orange marks
the selected location on both dates, including a reference on the old image;
it does not assert an old building. Edit vertices in the right map with undo/redo
within the native edit session. Polygon rings are retained; multipart geometry
is not flattened for editing.

Candidate layers remain loaded while changing selection. Native selection
highlights use persistent reference features; the editable selection layer is
created only when **Edit vertices** is chosen. Review decisions update styles
without reloading layers; geometry edits refresh candidate geometry when leaving
the edit session.

Approve, Reject or Pending records reviewer and note. Geometry edits reset
approval and recalculate area. Export writes approved candidates only, with
WGS84 geometry, metric areas, dates, scores and data/model/parameter provenance.
A geometry hash prevents exporting changed geometry under an old approval.
Decisions are session-only until export; rerunning asks before replacing them.

Downloads and analysis use workers. Cancel preserves the previous result.
The native instance task supports cancellation; the additional score pass must
finish before cancel/close completes. Shutdown awaits workers, detaches map
readers and removes its own session files. Extent synchronization runs after
native callbacks return. The raw-score FFI is asynchronous with no progress
callback, avoiding synchronous Node/native callback deadlocks.

## Analysis and default filters

Each date uses the native `hotosm-buildings` task for instances and a second
`FloatBands` pass for matching scores. The public 1.5.39 API does not expose
decoded scores from the instance task. Sigmoid is applied after logit blending;
Qt applies it before tile blending. Defaults match Qt's policy, but outputs are
not bit-identical and the extra passes increase runtime.

| Filter | Minimum area | Other-date coverage below | Tolerance | Own mean at least | Other mean at most |
|---|---:|---:|---:|---:|---:|
| Conservative | 50 m² | 0.10 | 2 m | 0.75 | 0.20 |
| Balanced | 20 m² | 0.20 | 1 m | 0.55 | 0.35 |

Coverage uses other-date scores ≥ 0.25 with the matching buffer. Border-touching
instances are excluded. Analysis/areas use EPSG:25831; viewing/export use WGS84.
CPU functional validation produced 0/68 instances and 42 additions in the fixed
demo, matching the .NET/Python/Rust ports. No reference change labels are included;
candidate counts do not measure accuracy.

## Verified inputs

[Imagery ZIP](https://github.com/geokernel-io/GeoKernel.SampleData/releases/download/v1/almere_oosterwold_change_2016_2025_v1.zip)
includes `oosterwold_2016-epsg25831-50cm.tif`,
`oosterwold_2025-epsg25831-50cm.tif`, README, attribution and source manifest.
Each image is 2048 × 2048 RGB Byte, 0.5 m. EPSG:25831 bounds:
`657533,5800382,658557,5801406`; demo bounds:
`657885,5800734,658205,5801054`.

Imagery: Beeldmateriaal Nederland / PDOK,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
[provider attribution](https://www.beeldmateriaal.nl/dataroom).
The GeoTIFFs contain WMS JPEG renders of 0.25 m annual layers at 0.5 m, converted
without further pixel loss. Annual layer years are not verified flight dates;
registration, shadows and vegetation can cause false changes.

[Model package](https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/hotosm-dinov3s-buildings-geokernel-onnx-v1.zip):
HOTOSM / DINOv3-S. Preserve the package's attribution, model/dataset cards,
CC BY 4.0 and separate Meta DINOv3 license and applicable terms.

| Object | SHA-256 |
|---|---|
| Imagery ZIP | `ecc35ef2c6bbdd586adc6ecc812ce1c74aee62fbf8e404de1d63b75bf7137a88` |
| 2016 image | `db723783db4c8738a716fe8b898de2e3099bab9394e335bd489db2412ae0c5c3` |
| 2025 image | `7b1b12d8b27cd0714f140415004daf9fd0000495eda31366c7cd4aab218caa82` |
| Model ZIP | `3a6cd11e013f81b46b3db700feddef2d98319780285b8320e1200573684b24bb` |
| model.onnx | `9a28e28403accc06c70a3104aedb31eca50401ed23c8ba4314b26357c25e9043` |

Assets use `%LOCALAPPDATA%\GeoKernel\Examples\GeoAI`, keyed by archive hash.
Set `GEOKERNEL_EXAMPLES_DATA_DIR` to override it. Original imagery is unchanged;
session overlays and inference outputs are temporary.
