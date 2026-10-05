"use strict";
const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class LayerStylingViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadFeaturesOnTerrain: ["int", ["void *", "str", "str", "str", "str", "float", "int"]],
        GetLayerStyling: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
        UpdateLayerStyling: ["int", ["void *", "str"]],
      },
    });
  }
  loadFeatures(dem, image, roads, buildings) {
    this.check(this.api.LoadFeaturesOnTerrain(this.handle, dem, image, roads, buildings, 9, 512));
  }
  layers() {
    const json = [null];
    this.check(this.api.GetLayerStyling(this.handle, json));
    if (json[0] === null) throw new Error("SDK returned no layer snapshot.");
    return JSON.parse(json[0]);
  }
  update(command) {
    this.check(this.api.UpdateLayerStyling(this.handle, JSON.stringify(command)));
  }
}
module.exports = { LayerStylingViewer };
