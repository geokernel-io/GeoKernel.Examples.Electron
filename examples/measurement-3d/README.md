# Measurement3D — Electron

Downloads and opens the Sagrada Família DEM and orthophoto. Click terrain to
measure a polyline or polygon. The native overlay and coordinate table show the
measurement. Finish stops capture; Undo and Clear edit the points.

Uses the existing native host/event pump and measurement API. Physical ENU metres
are independent of exaggeration. 3D length uses straight segments, not terrain
following; area is horizontal plan area. Maximum 64 points. DEM datum is unverified.

Uses the published GeoKernel 1.5.32 package. No local SDK build or DLL override is required.

```cmd
cd /d "D:\projects\GeoKernel.Examples.Electron" && npm install && npm run measurement-3d
```

All native calls stay on the main thread. Snapshots are copied every 150 ms;
only changed results are sent to the isolated renderer. No native pointer crosses IPC.
