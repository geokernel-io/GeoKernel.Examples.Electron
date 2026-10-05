"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("measurement", {
  action: (name, value) => ipcRenderer.invoke("measurement:action", name, value),
  onStatus: (callback) => ipcRenderer.on("measurement:status", (_event, value) => callback(value)),
  onResult: (callback) => ipcRenderer.on("measurement:result", (_event, value) => callback(value)),
});
