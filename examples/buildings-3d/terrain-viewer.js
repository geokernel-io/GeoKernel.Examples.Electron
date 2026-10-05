"use strict";

const path = require("path");
const koffi = require("koffi");
const { createNativeLibrary, findBinDir } = require("geokernel-electron");

// The 1.5.31 package exposes the Viewer3D C API; all calls stay on Electron's main thread.
class TerrainViewer {
  constructor(parent, { libraryPath, extraSignatures = {}, createFunction = "Create" } = {}) {
    if (process.platform !== "win32") throw new Error("Buildings3D requires Windows x64.");
    this.runtime = createNativeLibrary();
    this.pump = this.runtime.getFunction("GeoKernelViewer_ProcessEvents");
    this.pump();
    const library = libraryPath ? path.resolve(libraryPath) : path.join(findBinDir(), "GeoKernel.Viewer3D.dll");
    this.library = koffi.load(library);
    this.api = {};
    const signatures = {
      Create: ["void *", ["void *"]],
      Destroy: ["void", ["void *"]],
      LastError: ["str", []],
      Resize: ["int", ["void *", "int", "int"]],
      LoadBuildingsOnTerrain: ["int", ["void *", "str", "str", "str", "float", "int"]],
      SetBuildingStyle: ["int", ["void *", "int", "float", "int", "int", "int"]],
      GetBuildingVertexCount: ["int", ["void *", koffi.out(koffi.pointer("uint64"))]],
      SetImageryVisible: ["int", ["void *", "int"]],
      PollLoad: ["int", ["void *"]],
      CancelLoad: ["void", ["void *"]],
      SetColorRamp: ["int", ["void *", "int"]],
      SetHeightScale: ["int", ["void *", "float"]],
      ResetCamera: ["int", ["void *"]],
      ...extraSignatures,
    };
    for (const [name, [result, args]] of Object.entries(signatures)) {
      try {
        this.api[name] = this.library.func("GeoKernel3D_" + name, result, args);
      } catch (error) {
        throw new Error(`The selected Viewer3D DLL lacks ${name}: ${library}. Use an SDK build containing this API.`, { cause: error });
      }
    }
    const user32 = koffi.load("user32.dll");
    this.createHost = user32.func("void * __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, void *, void *, void *, void *)");
    this.moveHost = user32.func("bool __stdcall MoveWindow(void *, int, int, int, int, bool)");
    this.positionHost = user32.func("bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)");
    this.destroyHost = user32.func("bool __stdcall DestroyWindow(void *)");
    this.host = this.createHost(0, "STATIC", "", 0x56000000, 0, 0, 1, 1, parent, null, null, null);
    if (!this.host) throw new Error("Cannot create the terrain host window.");
    this.handle = this.api[createFunction](this.host);
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

  load(file, imagery, buildings, buildingHeight, resolution) {
    if (!Number.isFinite(buildingHeight) || buildingHeight < 1 || buildingHeight > 300) {
      throw new Error("Building height must be between 1 and 300 metres.");
    }
    this.check(this.api.LoadBuildingsOnTerrain(this.handle, file, imagery, buildings, buildingHeight, resolution));
  }

  buildingStyle(visible, opacity, color) {
    if (typeof visible !== "boolean" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
        typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error("Invalid building style.");
    }
    const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
    this.check(this.api.SetBuildingStyle(this.handle, visible ? 1 : 0, opacity, ...rgb));
  }

  buildingVertexCount() {
    const count = [0];
    this.check(this.api.GetBuildingVertexCount(this.handle, count));
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
