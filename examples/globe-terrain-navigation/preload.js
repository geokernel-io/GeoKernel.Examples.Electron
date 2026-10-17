"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("globe", {
  navigate: (action) => ipcRenderer.invoke("globe:navigate", action),
  toggle: (key, enabled) => ipcRenderer.invoke("globe:toggle", key, enabled),
  onState: (callback) => ipcRenderer.on("globe:state", (_event, state) => callback(state)),
});
