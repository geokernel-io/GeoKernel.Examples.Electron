"use strict";

function sdk() {
  const version = require("geokernel-electron/package.json").version;
  if (version !== "1.5.39") throw new Error(`GeoAI examples require geokernel-electron 1.5.39; installed: ${version}. Run npm install.`);
  return require("geokernel-electron");
}

module.exports = { sdk };
