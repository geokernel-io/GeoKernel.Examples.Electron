"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("globe", {
  change: (key, value) => ipcRenderer.invoke("globe:change", key, value),
  onState: (callback) => ipcRenderer.on("globe:state", (_event, state) => callback(state)),
});
