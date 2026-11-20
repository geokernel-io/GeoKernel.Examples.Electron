"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
contextBridge.exposeInMainWorld("orthoApi", {
  action: (name, value) => ipcRenderer.invoke("ortho:action", name, value),
  onInit: on("ortho:init"),
  onStatus: on("ortho:status"),
  onScene: on("ortho:scene"),
  onDisplay: on("ortho:display"),
  onInput: on("ortho:input"),
  onMode: on("ortho:mode"),
  onModels: on("ortho:models"),
  onProbe: on("ortho:probe"),
  onState: on("ortho:state"),
});
