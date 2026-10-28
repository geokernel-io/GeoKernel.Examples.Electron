"use strict";

const { dialog } = require("electron");
const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { PRUE } = require("../common/geoai-profiles");

const PROFILE = {
  ...PRUE, task: "sen2sr-super-resolution", title: "ESAOpenSR SEN2SRLite — super resolution",
  spectralPreview: "sen2sr-rgb", runLabel: "Run 4× super resolution", saveLabel: "Save GeoTIFF",
  exportName: "sen2sr-reflectance.tif", opacityLabel: "Enhanced opacity (right = enhanced image)",
  model: {
    url: "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/esaopensr-sen2srlite-rgbn-x4-geokernel-onnx-v1.zip",
    sha: "bcad3673c73429fddc6f6277fff823b01bdc77a268aee8b09540566d510d1017", required: "geokernel-model.json",
  },
  description: "Sentinel-2 RGB + NIR · 578 × 379 input. Click Run to generate a 4× result.",
  legend: "Estimated detail on a finer grid, not new sensor measurements.\nModel: ESAOpenSR / SEN2SRLite; CC0-1.0 and inherited Apache-2.0 notices.\nImagery: Sentinel-2 / FTW sample; retain source notices.",
};

class Sen2srSuperResolutionExample extends GeoAiExample {
  constructor() {
    super(PROFILE);
    this.sourceDisplay = null;
    this.comparisonSource = false;
  }

  async prepareInput() {
    const prepared = await super.prepareInput();
    this.sourceDisplay = prepared.display;
    return prepared;
  }

  detachResult() {
    if (!this.overlay && !this.comparisonSource) return;
    // Both comparison previews belong to the old job. Restore a persistent source before release.
    this.viewer.clearLayers();
    this.overlay = this.comparisonSource = false;
    if (this.sourceDisplay) {
      this.viewer.addLayerFile(this.sourceDisplay);
      this.viewer.setLayerName(0, this.profile.sourceName);
    }
  }

  completed(result) {
    this.viewer.clearLayers();
    this.comparisonSource = true;
    this.viewer.addLayerFile(result.sourcePreviewPath);
    this.viewer.setLayerName(0, "Source — shared contrast");
    this.viewer.addLayerFile(result.previewPath);
    this.viewer.setLayerName(0, "4× enhanced — shared contrast");
    this.overlay = true;
    this.applyOpacity(this.opacity);
    this.result = result;
    this.running = this.busy = false;
    this.log(`Provider: ${result.provider}\nSource: ${result.sourceWidth} × ${result.sourceHeight}\nOutput: ${result.width} × ${result.height} · 4 bands · Float32\nElapsed: ${result.elapsedMilliseconds} ms\n\nMove the slider to compare the same-stretch RGB previews.\nSave GeoTIFF retains RGB + NIR, source footprint and AI provenance.\n\n${this.legend()}`);
    this.progress(100, "Super resolution complete.");
    this.controls();
  }

  async save() {
    if (this.busy || !this.result || this.closing) return;
    const choice = await dialog.showSaveDialog({ title: "Save enhanced reflectance", defaultPath: PROFILE.exportName,
      filters: [{ name: "GeoTIFF", extensions: ["tif"] }] });
    if (!choice.canceled && choice.filePath) await this.exportTo(choice.filePath);
  }

  async exportTo(destination) {
    if (!this.result) return;
    await this.execute("export", async () => {
      await this.job.export(destination, "geotiff");
      this.progress(100, "Four-band GeoTIFF saved.");
    });
  }
}

let example;
async function start() { await launch(() => { example = new Sen2srSuperResolutionExample(); return example; }); }
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, Sen2srSuperResolutionExample, ID };
