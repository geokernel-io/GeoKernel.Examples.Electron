"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("dsm", {
  action: (name, value) => ipcRenderer.invoke("dsm:action", name, value),
  onInit: (callback) => ipcRenderer.on("dsm:init", () => callback()),
  onStatus: (callback) => ipcRenderer.on("dsm:status", (_event, state) => callback(state)),
  onCommitted: (callback) => ipcRenderer.on("dsm:committed", (_event, state) => callback(state)),
  onRestore: (callback) => ipcRenderer.on("dsm:restore", (_event, state) => callback(state)),
});
