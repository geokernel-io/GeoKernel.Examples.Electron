"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cloud", {
  action: (name, value) => ipcRenderer.invoke("cloud:action", name, value),
  onStatus: (callback) => ipcRenderer.on("cloud:status", (_event, value) => callback(value)),
  onState: (callback) => ipcRenderer.on("cloud:state", (_event, value) => callback(value)),
  onError: (callback) => ipcRenderer.on("cloud:error", (_event, value) => callback(value)),
});
