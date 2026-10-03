"use strict";
const fs = require("fs");
const path = require("path");
function valid(c) {
  return Array.isArray(c) && c.length === 6 && c.every(Number.isFinite) && c[1] >= -85 && c[1] <= 85 && c[2] >= .005 && c[2] <= 20;
}
class CameraNavigation {
  constructor(viewer, file) {
    this.viewer = viewer; this.file = file; this.home = null; this.smooth = true; this.views = [];
    try {
      if (fs.existsSync(file)) {
        const entries = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(entries)) this.views = entries.filter(v => v && typeof v.name === "string" && v.name.trim() && valid(v.camera)).slice(0, 20);
      }
    } catch (error) { console.warn("Saved camera views could not be read:", error.message); }
  }
  move(c) { this.viewer.moveCamera(c, this.smooth ? 1200 : 0); }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(this.views)); fs.renameSync(temporary, this.file);
  }
  state() { return { camera: this.viewer.camera(), names: this.views.map(v => v.name) }; }
  action(action, value) {
    if (action === "smooth" && typeof value === "boolean") { this.viewer.stopCamera(); this.smooth = value; }
    else if (action === "stop") this.viewer.stopCamera();
    else if (action === "preset" && Number.isInteger(value) && value >= 0 && value <= 4) {
      const c = this.home.slice();
      if (value === 1) { c[0] = 0; c[1] = 85; }
      if (value === 2) { c[0] = 90; c[1] = 35; }
      if (value === 3) { c[0] = -90; c[1] = 35; }
      if (value === 4) { c[1] = 30; c[2] = Math.max(.005, c[2] * .55); }
      this.move(c);
    } else if (action === "zoom" && (value === "in" || value === "out")) {
      const c = this.viewer.camera(); c[2] = Math.max(.005, Math.min(20, c[2] * (value === "in" ? .7 : 1 / .7))); this.move(c);
    } else if (action === "north") { const c = this.viewer.camera(); c[0] = 0; this.move(c); }
    else if (action === "save" && typeof value === "string" && value.trim() && value.length <= 120 && this.views.length < 20) {
      this.viewer.stopCamera(); this.views.push({ name: value.trim(), camera: this.viewer.camera() }); this.persist();
    } else if (Number.isInteger(value) && value >= 0 && value < this.views.length) {
      if (action === "restore") this.move(this.views[value].camera);
      else if (action === "delete") { this.views.splice(value, 1); this.persist(); }
    }
    return this.state();
  }
}
module.exports = { CameraNavigation };
