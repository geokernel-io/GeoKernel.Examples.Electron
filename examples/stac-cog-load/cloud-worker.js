"use strict";

const { CloudClient, ViewerWindow } = require("geokernel-electron");

// GeoKernel.Cloud uses Qt networking internally. A hidden ViewerWindow creates
// the QApplication/event-loop context required by the native STAC client in
// this isolated Electron Node worker.
let runtimeHost = null;

function ensureRuntimeHost() {
  if (runtimeHost) return;
  runtimeHost = new ViewerWindow({
    title: "StacCogLoad cloud worker",
    width: 160,
    height: 120,
    navigationToolbar: false,
  });
  runtimeHost.processEvents();
}

function send(message) {
  if (process.send) process.send(message);
}

function tileId(properties) {
  return `${properties["mgrs:utm_zone"] ?? ""}${properties["mgrs:latitude_band"] ?? ""}${properties["mgrs:grid_square"] ?? ""}`;
}

process.on("message", (message) => {
  if (message?.type !== "search") return;
  let cloud = null;
  try {
    ensureRuntimeHost();
    cloud = new CloudClient({ maximumMemoryBytes: 64 * 1024 * 1024, maximumDiskBytes: 1024 * 1024 * 1024 });
    cloud.setTimeout(15000);
    send({ type: "progress", id: message.id, value: 10, text: "Searching the Earth Search STAC catalog..." });
    const result = cloud.stacSearch(message.catalog, {
      collections: [message.collection],
      bbox: message.bbox,
      datetime: "2024-01-01T00:00:00Z/..",
      limit: 100,
      query: { "eo:cloud_cover": { lt: 20 } },
    });

    send({ type: "progress", id: message.id, value: 25, text: "Selecting one recent scene per MGRS tile..." });
    const selected = [];
    const seen = new Set();
    for (const item of result.items ?? []) {
      const properties = item.properties ?? {};
      const tile = tileId(properties);
      const url = item.assets?.visual?.href;
      if (!url || tile.length < 4 || seen.has(tile)) continue;
      seen.add(tile);
      selected.push({ item, properties, tile, url });
      if (selected.length >= 16) break;
    }
    if (!selected.length) throw new Error("STAC search returned no visual COG assets.");

    const assets = [];
    for (let index = 0; index < selected.length; index += 1) {
      const candidate = selected[index];
      const value = 30 + Math.floor((index + 1) * 35 / selected.length);
      send({ type: "progress", id: message.id, value, text: `Probing COG tile ${index + 1} of ${selected.length}...` });
      const probe = cloud.cogProbe(candidate.url);
      if (!probe.cloudReadable) continue;
      assets.push({
        tile: candidate.tile,
        itemId: candidate.item.id,
        datetime: candidate.properties.datetime ?? "",
        cloudCover: `${Number(candidate.properties["eo:cloud_cover"] ?? 0).toFixed(1)}%`,
        contentLength: Number(probe.contentLength ?? 0),
        acceptsRanges: Boolean(probe.acceptsRanges),
        firstIfdOffset: Number(probe.firstIfdOffset ?? 0),
        path: cloud.cogGdalVirtualPath(candidate.url),
      });
    }
    if (!assets.length) throw new Error("No cloud-readable visual COG assets were found.");
    send({ type: "result", id: message.id, assets });
  } catch (error) {
    send({ type: "error", id: message.id, message: error?.message ?? String(error) });
  } finally {
    cloud?.close();
  }
});

process.on("disconnect", () => {
  if (runtimeHost) {
    try { runtimeHost.close(); } catch {}
    runtimeHost = null;
  }
  process.exit(0);
});
