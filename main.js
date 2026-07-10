"use strict";

const { app } = require("electron");

const EXAMPLES = {
  "hello-map": "./examples/hello-map/main",
};

const exampleName = process.argv[2] || "hello-map";
let activeExample = null;

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.whenReady().then(async () => {
  const modulePath = EXAMPLES[exampleName];
  if (!modulePath) {
    throw new Error(`Unknown GeoKernel Electron example: ${exampleName}`);
  }

  activeExample = require(modulePath);
  await activeExample.start();
}).catch(fail);

app.on("before-quit", () => {
  activeExample?.stop?.();
  activeExample = null;
});
