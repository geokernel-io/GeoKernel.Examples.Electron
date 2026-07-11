"use strict";

const { app } = require("electron");
const path = require("path");

const EXAMPLES = {
  "add-layers": "./examples/add-layers/main",
  "hello-map": "./examples/hello-map/main",
};

function resolveExampleName(value) {
  if (!value) {
    return "hello-map";
  }

  if (EXAMPLES[value]) {
    return value;
  }

  const relativePath = path.isAbsolute(value)
    ? path.relative(process.cwd(), value)
    : value;
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const match = normalizedPath.match(/(?:^|\/)examples\/([^/]+)(?:\/|$)/);
  if (match && EXAMPLES[match[1]]) {
    return match[1];
  }

  return value;
}

const exampleName = resolveExampleName(process.argv[2]);
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
