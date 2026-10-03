"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("terrain", {
  action: (name, value) => ipcRenderer.invoke("terrain:action", name, value),
  onCamera: (callback) => ipcRenderer.on("camera:state", (_event, state) => callback(state)),
  onStatus: (callback) => ipcRenderer.on("terrain:status", (_event, state) => callback(state)),
});
