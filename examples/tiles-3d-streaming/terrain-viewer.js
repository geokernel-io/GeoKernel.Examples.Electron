"use strict";

const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class TilesViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadTilesTerrain: ["int", ["void *", "str", "str", "str", "str", "int"]],
        StartTiles: ["int", ["void *", "str", "int"]],
        StopTiles: ["int", ["void *", "int"]],
        FocusTiles: ["int", ["void *"]],
        GetTilesState: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
      },
    });
  }
  loadTilesTerrain(dem, image, geoid, tiles) {
    this.height(1);
    this.check(this.api.LoadTilesTerrain(this.handle, dem, image, geoid, tiles, 512));
  }
  startTiles(source, budget) { this.check(this.api.StartTiles(this.handle, source, budget)); }
  stopTiles(clear = false) { this.check(this.api.StopTiles(this.handle, clear ? 1 : 0)); }
  focusTiles() { this.check(this.api.FocusTiles(this.handle)); }
  tilesState() {
    const json = [null];
    this.check(this.api.GetTilesState(this.handle, json));
    if (json[0] === null) throw new Error("SDK returned no tiles state.");
    // Koffi copies the borrowed string; no native pointer leaves this module.
    return JSON.parse(json[0]);
  }
}

module.exports = { TilesViewer };
