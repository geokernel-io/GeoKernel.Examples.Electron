"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
contextBridge.exposeInMainWorld("accuracyApi", {
  action: (name, value) => ipcRenderer.invoke("accuracy:action", name, value),
  onInit: on("accuracy:init"),
  onStatus: on("accuracy:status"),
  onInstructions: on("accuracy:instructions"),
  onDisplay: on("accuracy:display"),
  onMetrics: on("accuracy:metrics"),
  onPreset: on("accuracy:preset"),
  onProbe: on("accuracy:probe"),
});
