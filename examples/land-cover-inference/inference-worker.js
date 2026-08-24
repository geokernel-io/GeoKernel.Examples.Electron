"use strict";

const { AI } = require("geokernel-electron");

process.on("message", (message) => {
  if (!message || message.type !== "infer") return;
  try {
    const ai = new AI();
    const result = ai.runRasterInference(message.request, (progress) => {
      if (process.connected) process.send({ type: "progress", id: message.id, progress });
    });
    if (process.connected) process.send({ type: "result", id: message.id, result });
  } catch (error) {
    if (process.connected) process.send({ type: "error", id: message.id, message: error?.message || String(error) });
  }
});
