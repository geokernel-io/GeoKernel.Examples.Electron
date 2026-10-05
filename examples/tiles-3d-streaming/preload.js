"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("tiles", {
  action: (name, value) => ipcRenderer.invoke("tiles:action", name, value),
  onStatus: (callback) => ipcRenderer.on("tiles:status", (_event, value) => callback(value)),
  onState: (callback) => ipcRenderer.on("tiles:state", (_event, value) => callback(value)),
  onError: (callback) => ipcRenderer.on("tiles:error", (_event, value) => callback(value)),
});
