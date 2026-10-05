"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("profile", {
  action: (name, value) => ipcRenderer.invoke("profile:action", name, value),
  onStatus: (callback) => ipcRenderer.on("profile:status", (_event, value) => callback(value)),
  onResult: (callback) => ipcRenderer.on("profile:result", (_event, value) => callback(value)),
});
