"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("terrain", {
  action: (name, value) => ipcRenderer.invoke("terrain:action", name, value),
  onStatus: (callback) => ipcRenderer.on("terrain:status", (_event, state) => callback(state)),
});
