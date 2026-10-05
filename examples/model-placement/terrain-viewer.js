"use strict";

const path = require("path");
const koffi = require("koffi");
const { createNativeLibrary, findBinDir } = require("geokernel-electron");

// The 1.5.31 package exposes the Viewer3D C API; all calls stay on Electron's main thread.
class TerrainViewer {
  constructor(parent) {
    if (process.platform !== "win32") throw new Error("ModelPlacement requires Windows x64.");
    this.runtime = createNativeLibrary();
    this.pump = this.runtime.getFunction("GeoKernelViewer_ProcessEvents");
    this.pump();
    const library = path.join(findBinDir(), "GeoKernel.Viewer3D.dll");
    this.library = koffi.load(library);
    this.api = {};
    const signatures = {
      Create: ["void *", ["void *"]],
      Destroy: ["void", ["void *"]],
      LastError: ["str", []],
      Resize: ["int", ["void *", "int", "int"]],
      LoadModelOnTerrain: ["int", ["void *", "str", "str", "str", "str", koffi.pointer("double"), "int"]],
      SetModelVisible: ["int", ["void *", "int"]],
      FocusModel: ["int", ["void *"]],
      GetModelVertexCount: ["int", ["void *", koffi.out(koffi.pointer("uint64"))]],
      SetImageryVisible: ["int", ["void *", "int"]],
      PollLoad: ["int", ["void *"]],
      CancelLoad: ["void", ["void *"]],
      SetColorRamp: ["int", ["void *", "int"]],
      SetHeightScale: ["int", ["void *", "float"]],
      ResetCamera: ["int", ["void *"]],
    };
    for (const [name, [result, args]] of Object.entries(signatures)) {
      try {
        this.api[name] = this.library.func("GeoKernel3D_" + name, result, args);
      } catch (error) {
        throw new Error(`The selected Viewer3D DLL lacks ${name}: ${library}. Install geokernel-electron@1.5.31.`, { cause: error });
      }
    }
    const user32 = koffi.load("user32.dll");
    this.createHost = user32.func("void * __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, void *, void *, void *, void *)");
    this.moveHost = user32.func("bool __stdcall MoveWindow(void *, int, int, int, int, bool)");
    this.positionHost = user32.func("bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)");
    this.destroyHost = user32.func("bool __stdcall DestroyWindow(void *)");
    this.host = this.createHost(0, "STATIC", "", 0x56000000, 0, 0, 1, 1, parent, null, null, null);
    if (!this.host) throw new Error("Cannot create the terrain host window.");
    this.handle = this.api.Create(this.host);
    if (!this.handle) {
      const error = this.api.LastError();
      this.destroyHost(this.host);
      this.host = null;
      throw new Error(error || "Viewer3D creation failed.");
    }
  }

  check(result) {
    if (result < 0) throw new Error(this.api.LastError() || "Viewer3D failed.");
    return result;
  }

  resize(width, height, scale) {
    if (!this.handle) return;
    const left = Math.round(280 * scale);
    const w = Math.max(1, Math.round(width * scale) - left);
    const h = Math.max(1, Math.round(height * scale));
    if (!this.moveHost(this.host, left, 0, w, h, true)) throw new Error("Cannot resize terrain host.");
    // Chromium owns a sibling HWND covering the client area. Keep the native
    // terrain host above that sibling without activating or moving the window.
    if (!this.positionHost(this.host, null, 0, 0, 0, 0, 0x0013)) {
      throw new Error("Cannot position terrain above the browser surface.");
    }
    this.check(this.api.Resize(this.handle, w, h));
  }

  load(file, imagery, model, geoid, placement, resolution) {
    if (!Array.isArray(placement) || placement.length !== 7 || !placement.every(Number.isFinite)) {
      throw new Error("Specify seven finite placement values.");
    }
    this.check(this.api.LoadModelOnTerrain(this.handle, file, imagery, model, geoid, placement, resolution));
  }
  modelVisible(visible) { this.check(this.api.SetModelVisible(this.handle, visible ? 1 : 0)); }
  focusModel() { this.check(this.api.FocusModel(this.handle)); }
  modelVertexCount() {
    const count = [0];
    this.check(this.api.GetModelVertexCount(this.handle, count));
    return Number(count[0]);
  }
  imagery(visible) { this.check(this.api.SetImageryVisible(this.handle, visible ? 1 : 0)); }
  poll() {
    const state = this.api.PollLoad(this.handle);
    return state === -2 ? state : this.check(state);
  }
  cancel() { if (this.handle) this.api.CancelLoad(this.handle); }
  ramp(value) { this.check(this.api.SetColorRamp(this.handle, value)); }
  height(value) { this.check(this.api.SetHeightScale(this.handle, value)); }
  reset() { this.check(this.api.ResetCamera(this.handle)); }

  close() {
    if (this.handle) this.api.Destroy(this.handle);
    this.handle = null;
    if (this.host) this.destroyHost(this.host);
    this.host = null;
  }
}

module.exports = { TerrainViewer };
