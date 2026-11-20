"use strict";

const path = require("path");
const koffi = require("koffi");
const { findBinDir } = require("geokernel-electron");

let user32 = null;
function windows() {
  if (user32) return user32;
  const library = koffi.load("user32.dll");
  user32 = {
    create: library.func("void * __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, void *, void *, void *, void *)"),
    move: library.func("bool __stdcall MoveWindow(void *, int, int, int, int, bool)"),
    position: library.func("bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)"),
    destroy: library.func("bool __stdcall DestroyWindow(void *)"),
  };
  return user32;
}

let api = null;
function viewer3d() {
  if (api) return api;
  const library = koffi.load(path.join(findBinDir(), "GeoKernel.Viewer3D.dll"));
  api = {};
  const signatures = {
    Create: ["void *", ["void *"]],
    Destroy: ["void", ["void *"]],
    LastError: ["str", []],
    Resize: ["int", ["void *", "int", "int"]],
    LoadTerrainAndImagery: ["int", ["void *", "str", "str", "int"]],
    PollLoad: ["int", ["void *"]],
    CancelLoad: ["void", ["void *"]],
    SetHeightScale: ["int", ["void *", "float"]],
    GetCamera: ["int", ["void *", koffi.out(koffi.pointer("float"))]],
    MoveCamera: ["int", ["void *", "float *", "int"]],
    ResetCamera: ["int", ["void *"]],
  };
  for (const [name, [result, args]] of Object.entries(signatures)) api[name] = library.func("GeoKernel3D_" + name, result, args);
  return api;
}

/** One native Viewer3D in a child HWND of the BrowserWindow, placed over a page rectangle. */
class Viewer3D {
  constructor(parent) {
    if (process.platform !== "win32") throw new Error("DsmToDtm requires the Windows x64 Viewer3D runtime.");
    this.api = viewer3d();
    const w = windows();
    this.host = w.create(0, "STATIC", "", 0x56000000, 0, 0, 1, 1, parent, null, null, null);
    if (!this.host) throw new Error("Cannot create the terrain host window.");
    this.handle = this.api.Create(this.host);
    if (!this.handle) {
      const error = this.api.LastError();
      w.destroy(this.host);
      this.host = null;
      throw new Error(error || "Viewer3D creation failed.");
    }
  }

  check(result) {
    if (result < 0) throw new Error(this.api.LastError() || "Viewer3D failed.");
    return result;
  }

  /** Place the host in physical client pixels and keep it above Chromium's sibling surface. */
  place(x, y, width, height) {
    if (!this.handle) return;
    const w = windows();
    width = Math.max(1, width); height = Math.max(1, height);
    if (!w.move(this.host, x, y, width, height, true)) throw new Error("Cannot resize terrain host.");
    if (!w.position(this.host, null, 0, 0, 0, 0, 0x0013)) throw new Error("Cannot position terrain above the browser surface.");
    this.check(this.api.Resize(this.handle, width, height));
  }

  load(file, imagery, resolution) { this.check(this.api.LoadTerrainAndImagery(this.handle, file, imagery, resolution)); }
  poll() {
    const state = this.api.PollLoad(this.handle);
    return state === -2 ? state : this.check(state);
  }
  cancel() { if (this.handle) this.api.CancelLoad(this.handle); }
  height(value) { if (this.handle) this.check(this.api.SetHeightScale(this.handle, value)); }
  reset() { this.check(this.api.ResetCamera(this.handle)); }
  camera() { const values = new Float32Array(6); this.check(this.api.GetCamera(this.handle, values)); return Array.from(values); }
  moveCamera(values, duration = 0) { this.check(this.api.MoveCamera(this.handle, Float32Array.from(values), duration)); }

  close() {
    if (this.handle) { this.api.CancelLoad(this.handle); this.api.Destroy(this.handle); }
    this.handle = null;
    if (this.host) windows().destroy(this.host);
    this.host = null;
  }
}

module.exports = { Viewer3D };
