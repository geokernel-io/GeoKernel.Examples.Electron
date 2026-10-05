"use strict";

const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class MeasurementViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadTerrainAndImagery: ["int", ["void *", "str", "str", "int"]],
        SetMeasurementMode: ["int", ["void *", "int", "int"]],
        EditMeasurement: ["int", ["void *", "int"]],
        GetMeasurement: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
      },
    });
  }

  loadTerrain(dem, image) {
    this.check(this.api.LoadTerrainAndImagery(this.handle, dem, image, 512));
  }
  mode(area, capture) {
    this.check(this.api.SetMeasurementMode(this.handle, area ? 1 : 0, capture ? 1 : 0));
  }
  edit(undo) { this.check(this.api.EditMeasurement(this.handle, undo ? 1 : 0)); }
  measurement() {
    const json = [null];
    this.check(this.api.GetMeasurement(this.handle, json));
    if (json[0] === null) throw new Error("SDK returned no measurement snapshot.");
    // Koffi copies the borrowed UTF-8 string before any subsequent native call.
    return JSON.parse(json[0]);
  }
}

module.exports = { MeasurementViewer };
