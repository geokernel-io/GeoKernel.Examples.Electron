"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("viewshed", {
  action: (name, value) => ipcRenderer.invoke("viewshed:action", name, value),
  onStatus: (callback) => ipcRenderer.on("viewshed:status", (_event, value) => callback(value)),
  onResult: (callback) => ipcRenderer.on("viewshed:result", (_event, value) => callback(value)),
});
