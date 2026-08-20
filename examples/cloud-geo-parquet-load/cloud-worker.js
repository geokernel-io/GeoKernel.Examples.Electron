"use strict";

const { CloudClient } = require("geokernel-electron");

process.on("message", (message) => {
  if (message?.type !== "probe") return;
  let cloud = null;
  try {
    cloud = new CloudClient({
      memoryEnabled: true,
      maximumMemoryBytes: 4 * 1024 * 1024,
      diskEnabled: false,
      maximumDiskBytes: 0,
    });
    cloud.setTimeout(30000);
    const probe = cloud.probeGeoParquet(message.url);
    if (!probe.cloudReadable) throw new Error(probe.diagnostic || "Remote GeoParquet is not range-readable.");
    process.send?.({
      type: "result",
      id: message.id,
      path: cloud.geoParquetGdalVirtualPath(message.url),
      probe,
    });
  } catch (error) {
    process.send?.({ type: "error", id: message.id, message: error?.message ?? String(error) });
  } finally {
    try { cloud?.close(); } catch {}
  }
});
