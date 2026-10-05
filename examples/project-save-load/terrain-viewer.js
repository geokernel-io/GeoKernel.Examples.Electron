"use strict";
const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class ProjectViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        OpenProject: ["int", ["void *", "str"]],
        SaveProject: ["int", ["void *", "str"]],
        GetProjectDisplay: ["int", ["void *", koffi.out(koffi.pointer("float")), koffi.out(koffi.pointer("int"))]],
        LoadFeaturesOnTerrain: ["int", ["void *", "str", "str", "str", "str", "float", "int"]],
        GetLayerStyling: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
        UpdateLayerStyling: ["int", ["void *", "str"]],
      },
    });
  }
  openProject(file) { this.check(this.api.OpenProject(this.handle, file)); }
  saveProject(file) { this.check(this.api.SaveProject(this.handle, file)); }
  projectDisplay() {
    const height = [0], imagery = [0];
    this.check(this.api.GetProjectDisplay(this.handle, height, imagery));
    return { height: height[0], imagery: imagery[0] !== 0 };
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
module.exports = { ProjectViewer };
