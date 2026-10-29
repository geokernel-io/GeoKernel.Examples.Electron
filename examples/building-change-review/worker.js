"use strict";
const { parentPort, workerData } = require("worker_threads");
const flag = new Int32Array(workerData.cancellation);
const check = () => {
  if (Atomics.load(flag, 0)) throw Error("Cancelled.");
};
const progress = (percent, message) =>
  parentPort.postMessage({ percent, message });
async function run() {
  const core = require("./core");
  if (workerData.mode === "prepare-display") {
    const { bin, paths, destinations } = workerData.options;
    const gdal = new core.Gdal(bin);
    const displays = paths.map((source, i) => {
      check();
      progress(50 + i * 20, `Preparing ${i ? 2025 : 2016} map…`);
      return gdal.displayRaster(source, destinations[i]);
    });
    check();
    return displays;
  }
  return core.analyze(workerData.options, check, progress);
}
run().then(
  (result) => parentPort.postMessage({ result }),
  (error) => parentPort.postMessage({ error: error.stack || error.message }),
);
