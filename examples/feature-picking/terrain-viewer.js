"use strict";

const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class FeaturePickingViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadFeaturesOnTerrain: ["int", ["void *", "str", "str", "str", "str", "float", "int"]],
        GetFeatureSelection: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
        SetMultipleSelection: ["int", ["void *", "int"]],
        ActivateSelection: ["int", ["void *", "uint64", "uint64"]],
        ClearSelection: ["int", ["void *"]],
        FocusSelection: ["int", ["void *"]],
        SetRoadStyle: ["int", ["void *", "int", "float", "int", "int", "int"]],
      },
    });
  }

  loadFeatures(dem, image, roads, buildings) {
    this.check(this.api.LoadFeaturesOnTerrain(this.handle, dem, image, roads, buildings, 9, 512));
  }

  selection() {
    const json = [null];
    this.check(this.api.GetFeatureSelection(this.handle, json));
    // Koffi copies the borrowed UTF-8 string before the next native call.
    // Native IDs and revisions are decimal strings, avoiding JS precision loss.
    if (json[0] === null) throw new Error("SDK returned no selection snapshot.");
    return JSON.parse(json[0]);
  }

  multiple(enabled) { this.check(this.api.SetMultipleSelection(this.handle, enabled ? 1 : 0)); }
  activate(revision, index) {
    return this.check(this.api.ActivateSelection(this.handle, BigInt(revision), BigInt(index))) === 1;
  }
  clear() { this.check(this.api.ClearSelection(this.handle)); }
  focus() { this.check(this.api.FocusSelection(this.handle)); }
  roads(visible) { this.check(this.api.SetRoadStyle(this.handle, visible ? 1 : 0, 1, 240, 224, 160)); }
}

module.exports = { FeaturePickingViewer };
