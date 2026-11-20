"use strict";

// Runs one LLM proposal off the main thread so the native window keeps pumping events.
// GeoKernelGisLlm_Propose keeps its result per thread, so the call and the read of its
// result both happen here.
const { parentPort, workerData } = require("worker_threads");

try {
  const { propose } = require(workerData.module);
  const proposal = propose(workerData.intent, workerData.grounding, null, { binDir: workerData.binDir });
  parentPort.postMessage({ proposal });
} catch (error) {
  parentPort.postMessage({ error: error?.message || String(error) });
}
