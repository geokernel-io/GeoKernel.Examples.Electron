"use strict";

const { CloudClient } = require("geokernel-electron");

process.on("message", (message) => {
  if (message?.type !== "probe") return;
  let cloud = null;
  try {
    // The probe only reads the PMTiles header and root directory. A disk cache
    // adds no value here and can make startup proportional to the number of
    // cached byte-range files left by earlier map sessions.
    cloud = new CloudClient({
      memoryEnabled: true,
      maximumMemoryBytes: 4 * 1024 * 1024,
      diskEnabled: false,
      maximumDiskBytes: 0,
    });
    cloud.setTimeout(30000);
    const probe = cloud.probePmTiles(message.url);
    if (!probe.cloudReadable) throw new Error(probe.diagnostic || "Remote PMTiles is not range-readable.");
    process.send?.({ type: "result", id: message.id, path: cloud.pmTilesGdalVirtualPath(message.url), probe });
  } catch (error) {
    process.send?.({ type: "error", id: message.id, message: error?.message ?? String(error) });
  } finally {
    try { cloud?.close(); } catch {}
  }
});
