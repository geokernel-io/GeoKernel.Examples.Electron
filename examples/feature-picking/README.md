# FeaturePicking

Automatically downloads Sagrada Família terrain, orthophoto, building footprints
and roads. Click features to inspect attributes, enable multiple selection, choose
the active feature and zoom to it. Visibility and terrain exaggeration are adjustable.
Building heights are illustrative (9 metres).

Uses the same native host and event pump as Buildings3D. Native selection is read
on the main thread every 150 ms; only changed snapshots are sent to the isolated
renderer. Feature identifiers and revisions remain strings to preserve precision.

## Current SDK requirement

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

If the native target has not been rebuilt since adding selection, use a fresh CMD:



Install dependencies and run:

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run feature-picking
```
