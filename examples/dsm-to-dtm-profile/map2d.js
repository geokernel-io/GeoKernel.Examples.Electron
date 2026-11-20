"use strict";

// One native GeoKernel 2D map in a child window of the BrowserWindow. The published
// geokernel-electron ViewerWindow owns its own top-level window, so this adapter uses the
// package's public native loader and the GeoKernelViewer C API directly, the same way the
// WinForms control hosts a viewer: create it, reparent its window and place it over a page
// rectangle. Native events are queued and handled after the event pump returns.
const koffi = require("koffi");
const { createNativeLibrary, Native } = require("geokernel-electron");
const { GeoKernelViewerEventCallback, GeoKernelViewerEventData } = Native;

let user32 = null;
function windows() {
  if (user32) return user32;
  const library = koffi.load("user32.dll");
  user32 = {
    create: library.func("void * __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, void *, void *, void *, void *)"),
    move: library.func("bool __stdcall MoveWindow(void *, int, int, int, int, bool)"),
    position: library.func("bool __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)"),
    destroy: library.func("bool __stdcall DestroyWindow(void *)"),
    // The viewer's window handle comes back from the C API as an integer (size_t).
    setParent: library.func("intptr_t __stdcall SetParent(uintptr_t, void *)"),
    setLong: library.func("intptr_t __stdcall SetWindowLongPtrW(uintptr_t, int, intptr_t)"),
    moveRaw: library.func("bool __stdcall MoveWindow(uintptr_t, int, int, int, int, bool)"),
    positionRaw: library.func("bool __stdcall SetWindowPos(uintptr_t, void *, int, int, int, int, uint32)"),
  };
  return user32;
}

let native = null;
function api() {
  if (!native) native = createNativeLibrary();
  return (name) => native.getFunction(name);
}

const WS_CHILD_VISIBLE_CLIP = 0x56000000; // WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN

class Map2D {
  constructor(parent, onEvent) {
    if (process.platform !== "win32") throw new Error("DsmToDtmProfile requires the Windows x64 GeoKernel runtime.");
    this.call = api();
    const w = windows();
    this.host = w.create(0, "STATIC", "", WS_CHILD_VISIBLE_CLIP, 0, 0, 1, 1, parent, null, null, null);
    if (!this.host) throw new Error("Cannot create the map host window.");
    this.handle = this.call("GeoKernelViewer_Create")(1, 1);
    if (!this.handle) { w.destroy(this.host); this.host = null; throw new Error("GeoKernelViewer_Create failed."); }
    this.window = this.call("GeoKernelViewer_GetNativeHandle")(this.handle);
    if (!this.window) { this.close(); throw new Error("The native map returned no window handle."); }
    w.setLong(this.window, -16, WS_CHILD_VISIBLE_CLIP); // GWL_STYLE
    w.setParent(this.window, this.host);
    w.positionRaw(this.window, null, 0, 0, 0, 0, 0x0037); // NOMOVE | NOSIZE | NOZORDER | NOACTIVATE | FRAMECHANGED
    this.callback = koffi.register((data, text) => {
      const value = koffi.decode(data, GeoKernelViewerEventData);
      onEvent({ type: value.eventType, int: value.intValue, int2: value.intValue2, extent: { ...value.extent }, screen: { ...value.screenRectangle }, text: text ?? "" });
    }, koffi.pointer(GeoKernelViewerEventCallback));
    this.call("GeoKernelViewer_SetEventCallback")(this.handle, this.callback, null);
    this.call("GeoKernelViewer_Show")(this.handle);
  }

  /** Place the host in physical client pixels and keep it above Chromium's sibling surface. */
  place(x, y, width, height) {
    if (!this.handle) return;
    const w = windows();
    width = Math.max(1, width); height = Math.max(1, height);
    w.move(this.host, x, y, width, height, true);
    w.position(this.host, null, 0, 0, 0, 0, 0x0013); // HWND_TOP, NOSIZE | NOMOVE | NOACTIVATE
    w.moveRaw(this.window, 0, 0, width, height, true);
    this.call("GeoKernelViewer_Resize")(this.handle, width, height);
    this.call("GeoKernelViewer_InvalidateRenderCache")(this.handle, false, false);
  }

  addLayer(file, name) {
    if (!this.call("GeoKernelViewer_AddLayerFile")(this.handle, file)) throw new Error(`The relief layer could not be added: ${file}`);
    this.call("GeoKernelViewer_SetLayerName")(this.handle, 0, name);
  }
  layerCount() { return this.call("GeoKernelViewer_GetLayerCount")(this.handle); }
  setLayerVisible(index, visible) { return this.call("GeoKernelViewer_SetLayerVisible")(this.handle, index, visible); }
  clearLayers() { this.call("GeoKernelViewer_ClearLayers")(this.handle); }
  refresh() { this.call("GeoKernelViewer_RefreshLayers")(this.handle); }
  setTool(tool) { this.call("GeoKernelViewer_SetTool")(this.handle, tool); }
  zoomIn(factor) { this.call("GeoKernelViewer_ZoomIn")(this.handle, factor); }
  zoomOut(factor) { this.call("GeoKernelViewer_ZoomOut")(this.handle, factor); }
  getExtent() {
    const extent = {};
    return this.call("GeoKernelViewer_GetViewExtent")(this.handle, extent) ? extent : null;
  }
  setExtent(extent) { this.call("GeoKernelViewer_SetViewExtent")(this.handle, extent); }

  clearShapes() { this.call("GeoKernelViewer_ClearShapes")(this.handle); }
  addPoint(x, y, style) { this.call("GeoKernelViewer_AddPointShape")(this.handle, x, y, JSON.stringify(style)); }
  addPolygon(ring, style) { this.call("GeoKernelViewer_AddPolygonShape")(this.handle, ring.flat(), ring.length, JSON.stringify(style)); }
  addLine(points, style) { this.call("GeoKernelViewer_AddPolylineShape")(this.handle, points.flat(), points.length, JSON.stringify(style)); }
  /** A lightweight overlay point that follows the map without re-rendering it. */
  setOverlayPoint(id, x, y, style) { this.call("GeoKernelViewer_SetOverlayPoint")(this.handle, id, x, y, JSON.stringify(style)); }

  close() {
    if (this.handle) {
      this.call("GeoKernelViewer_SetEventCallback")(this.handle, null, null);
      this.call("GeoKernelViewer_Destroy")(this.handle);
    }
    this.handle = null;
    if (this.callback) koffi.unregister(this.callback);
    this.callback = null;
    if (this.host) windows().destroy(this.host);
    this.host = null;
  }
}

module.exports = { Map2D, pump: () => api()("GeoKernelViewer_ProcessEvents")() };
