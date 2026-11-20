"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
contextBridge.exposeInMainWorld("processingApi", {
  action: (name, value) => ipcRenderer.invoke("processing:action", name, value),
  onInit: on("processing:init"),
  onStatus: on("processing:status"),
  onScene: on("processing:scene"),
  onDisplay: on("processing:display"),
  onMode: on("processing:mode"),
  onProbe: on("processing:probe"),
  onState: on("processing:state"),
});
