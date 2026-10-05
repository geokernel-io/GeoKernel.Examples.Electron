"use strict";

const { TerrainViewer: NativeViewer } = require("../buildings-3d/terrain-viewer");

class TerrainViewer extends NativeViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadTerrain: ["int", ["void *", "str", "int"]],
        SetTerrainDisplayMode: ["int", ["void *", "int"]],
      },
    });
  }
  load(file, resolution) { this.check(this.api.LoadTerrain(this.handle, file, resolution)); }
  mode(value) { this.check(this.api.SetTerrainDisplayMode(this.handle, value)); }
}

module.exports = { TerrainViewer };
