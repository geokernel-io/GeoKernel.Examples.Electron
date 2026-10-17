"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("globe", {
  onStatus: (callback) => ipcRenderer.on("globe:status", (_event, message) => callback(message)),
});
