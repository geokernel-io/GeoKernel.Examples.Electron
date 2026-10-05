"use strict";
const koffi = require("koffi");
const { TerrainViewer } = require("../buildings-3d/terrain-viewer");

class ViewshedViewer extends TerrainViewer {
  constructor(parent) {
    super(parent, {
      extraSignatures: {
        LoadTerrainAndImagery: ["int", ["void *", "str", "str", "int"]],
        ConfigureViewshed: ["int", ["void *", "double", "double", "double", "double", "int"]],
        SetViewshedCapture: ["int", ["void *", "int"]],
        ViewshedAction: ["int", ["void *", "int"]],
        SetViewshedOverlay: ["int", ["void *", "int"]],
        GetViewshed: ["int", ["void *", koffi.out(koffi.pointer("str"))]],
      },
    });
  }
  loadTerrain(dem, image) {
    this.check(this.api.LoadTerrainAndImagery(this.handle, dem, image, 512));
  }
  configure({ eye, target, radius, spacing, width }) {
    this.check(this.api.ConfigureViewshed(this.handle, eye, target, radius, spacing, width));
  }
  capture(enabled) { this.check(this.api.SetViewshedCapture(this.handle, enabled ? 1 : 0)); }
  overlay(visible) { this.check(this.api.SetViewshedOverlay(this.handle, visible ? 1 : 0)); }
  action(value) { this.check(this.api.ViewshedAction(this.handle, value)); }
  viewshed() {
    const json = [null];
    this.check(this.api.GetViewshed(this.handle, json));
    if (json[0] === null) throw new Error("SDK returned no viewshed snapshot.");
    return JSON.parse(json[0]);
  }
}
module.exports = { ViewshedViewer };
