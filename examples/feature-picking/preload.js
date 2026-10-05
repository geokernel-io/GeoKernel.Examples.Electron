"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("picking", {
  action: (name, value) => ipcRenderer.invoke("picking:action", name, value),
  onStatus: (callback) => ipcRenderer.on("picking:status", (_event, state) => callback(state)),
  onSelection: (callback) => ipcRenderer.on("picking:selection", (_event, state) => callback(state)),
});
