"use strict";

const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class PointCloudViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      createFunction: "CreatePointCloud",
      extraSignatures: {
        CreatePointCloud: ["void *", ["void *"]],
        LoadPointCloud: ["int", ["void *", "str", "int"]],
        SetPointCloudStyle: ["int", ["void *", "int"]],
        GetPointCloudState: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
      },
    });
  }
  loadCloud(file, limit) { this.check(this.api.LoadPointCloud(this.handle, file, limit)); }
  style(height) { this.check(this.api.SetPointCloudStyle(this.handle, height ? 1 : 0)); }
  state() {
    const json = [null];
    this.check(this.api.GetPointCloudState(this.handle, json));
    if (json[0] === null) throw new Error("SDK returned no point cloud state.");
    return JSON.parse(json[0]);
  }
}

module.exports = { PointCloudViewer };
