"use strict";

const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class ElevationProfileViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadTerrainAndImagery: ["int", ["void *", "str", "str", "int"]],
        SetProfileMode: ["int", ["void *", "int", "double"]],
        EditProfile: ["int", ["void *", "int"]],
        GetProfile: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
      },
    });
  }

  loadTerrain(dem, image) {
    this.check(this.api.LoadTerrainAndImagery(this.handle, dem, image, 512));
  }
  mode(capture, spacing) {
    this.check(this.api.SetProfileMode(this.handle, capture ? 1 : 0, spacing));
  }
  edit(undo) { this.check(this.api.EditProfile(this.handle, undo ? 1 : 0)); }
  profile() {
    const json = [null];
    this.check(this.api.GetProfile(this.handle, json));
    if (json[0] === null) throw new Error("SDK returned no profile snapshot.");
    // Koffi copies the borrowed UTF-8 string before any subsequent native call.
    return JSON.parse(json[0]);
  }
}

module.exports = { ElevationProfileViewer };
