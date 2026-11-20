"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("profileApi", {
  action: (name, value) => ipcRenderer.invoke("profile:action", name, value),
  onInit: (callback) => ipcRenderer.on("profile:init", () => callback()),
  onStatus: (callback) => ipcRenderer.on("profile:status", (_event, state) => callback(state)),
  onInstructions: (callback) => ipcRenderer.on("profile:instructions", (_event, text) => callback(text)),
  onHeading: (callback) => ipcRenderer.on("profile:heading", (_event, text) => callback(text)),
  onProfile: (callback) => ipcRenderer.on("profile:profile", (_event, profile) => callback(profile)),
});
