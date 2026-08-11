# GeoKernel Electron Examples

These examples use the published `geokernel-electron` npm package.

All examples load their application and toolbar icons from the repository-level
`images` directory. The launcher exposes that directory to the native viewer
through `GEOKERNEL_ICON_DIR`; icons are not read from `node_modules`.

```powershell
npm install
npm start
npm run add-layers
npm run layer-add-remove
npm run layer-reorder
npm run minimap
npm run measure
npm run project
npm run scalebar
```
