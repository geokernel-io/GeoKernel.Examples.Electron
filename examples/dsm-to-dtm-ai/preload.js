"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
contextBridge.exposeInMainWorld("aiApi", {
  action: (name, value) => ipcRenderer.invoke("ai:action", name, value),
  onInit: on("ai:init"),
  onStatus: on("ai:status"),
  onScene: on("ai:scene"),
  onDisplay: on("ai:display"),
  onMode: on("ai:mode"),
  onModel: on("ai:model"),
  onProbe: on("ai:probe"),
  onState: on("ai:state"),
});
