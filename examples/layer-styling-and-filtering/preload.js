"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("styling", {
  action: (name, value) => ipcRenderer.invoke("styling:action", name, value),
  onStatus: (callback) => ipcRenderer.on("styling:status", (_event, value) => callback(value)),
  onLoaded: (callback) => ipcRenderer.on("styling:loaded", (_event, value) => callback(value)),
});
