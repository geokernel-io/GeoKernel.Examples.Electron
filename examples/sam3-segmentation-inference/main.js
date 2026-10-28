"use strict";

const path = require("path");
const { dialog } = require("electron");
const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { HOTOSM } = require("../common/geoai-profiles");
const { ViewerTool, ViewerEventType } = require("../common/geoai-runtime").sdk();
const SAM = { MODE: 20, TEXT: 21, SCORE: 22, TOOL: 23, CLEAR: 24, ACCEPT: 25, DISCARD: 26, TIFF: 27, SELECTION: 28 };
const ROOT = "https://pub-00d214f25f754884b22349c19ac37bbf.r2.dev/geokernel-models/";
const HASHES = {
  text: "95d9bc3ebdec6a6147a9bfa97325712bfbb77fccbd6bb3f20be453c381820931",
  tracker: "c4309ed67b2292f64641d740f2558c2d4253476ca1ec40c17d49c4800c050896",
};
const PROFILE = {
  ...HOTOSM, task: "sam3-text", buildings: false, title: "Meta SAM3 — segmentation", runLabel: "Generate draft",
  description: "SAM3 text / point / box segmentation. No predictions are loaded at startup.",
  legend: "Draft instances require review. Point/box selects one object; it is not an area scan.\nModel: Meta SAM3; retain SAM License and package notices.\nImagery source/license not verified.",
  controls: [
    { id: SAM.MODE, type: "combo", label: "Task", options: ["Text segmentation", "Point / box segmentation"], value: "Text segmentation" },
    { id: SAM.TEXT, type: "text", label: "Text concept", value: "building" },
    { id: SAM.SCORE, type: "number", label: "Text score threshold", minimum: 0.01, maximum: 0.99, step: 0.05, decimals: 2, value: 0.50 },
    { id: SAM.TOOL, type: "combo", label: "Map tool", options: ["Pan map", "Positive point", "Negative point", "Box: click two corners"], value: "Pan map" },
    { id: SAM.SELECTION, type: "text", label: "Selection", value: "0 points · no box" },
    { id: SAM.CLEAR, type: "button", text: "Clear prompts" },
    { id: SAM.ACCEPT, type: "button", text: "Accept draft" },
    { id: SAM.DISCARD, type: "button", text: "Discard draft" },
    { id: SAM.TIFF, type: "button", text: "Save accepted GeoTIFF" },
  ],
};

class Sam3SegmentationExample extends GeoAiExample {
  constructor() {
    super(PROFILE);
    this.textMode = true;
    this.text = "building";
    this.score = 0.50;
    this.mapTool = "Pan map";
    this.points = [];
    this.box = null;
    this.corner = null;
    this.promptLayers = [];
    this.accepted = false;
    this.controls();
  }

  controls() {
    super.controls();
    if (this.textMode === undefined || this.closed) return;
    const editable = !this.busy && !this.closing && !this.result;
    this.viewer.setControlEnabled(ID.RUN, editable);
    this.viewer.setControlEnabled(SAM.MODE, editable);
    this.viewer.setControlEnabled(SAM.TEXT, editable && this.textMode);
    this.viewer.setControlEnabled(SAM.SCORE, editable && this.textMode);
    this.viewer.setControlEnabled(SAM.TOOL, editable && !this.textMode);
    this.viewer.setControlEnabled(SAM.CLEAR, editable);
    this.viewer.setControlEnabled(SAM.ACCEPT, !!this.result && !this.accepted && !this.busy && !this.closing);
    this.viewer.setControlEnabled(SAM.DISCARD, !!this.result && !this.busy && !this.closing);
    const save = !!this.result && this.accepted && !this.busy && !this.closing;
    this.viewer.setControlEnabled(ID.SAVE, save);
    this.viewer.setControlEnabled(SAM.TIFF, save);
    this.viewer.setControlEnabled(ID.CANCEL, this.busy && !["export", "cleanup"].includes(this.stage) && !this.closing);
    this.viewer.setTool(editable && !this.textMode && this.mapTool !== "Pan map" ? ViewerTool.INFO : ViewerTool.PAN);
  }

  async initialize() {
    await super.initialize();
    if (this.raster && !this.closing) {
      this.viewer.setCoordinateSystemPreset("wgs84");
      this.viewer.fullExtent();
    }
  }

  handleMapEvent(event) {
    if (event.eventType === ViewerEventType.MAP_MOUSE_DOWN && event.intValue2 === 1) {
      setImmediate(() => this.selectPoint(event.extent.xMin, event.extent.yMin));
    }
  }

  selectPoint(x, y) {
    if (this.busy || this.closing || this.result || this.textMode || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (this.mapTool === "Positive point" || this.mapTool === "Negative point") {
      if (this.points.length + (this.box ? 2 : 0) >= 64) { this.progress(0, "Prompt limit reached; clear prompts first."); return; }
      this.points.push({ x, y, positive: this.mapTool === "Positive point" });
    } else if (this.mapTool === "Box: click two corners") {
      if (this.points.length > 62) { this.progress(0, "A box needs two prompt tokens; clear points first."); return; }
      if (!this.corner) { this.corner = [x, y]; this.box = null; }
      else {
        const [a, b] = this.corner;
        this.corner = null;
        if (a === x || b === y) { this.progress(0, "Choose two different box corners."); this.drawPrompts(); return; }
        this.box = [Math.min(a, x), Math.min(b, y), Math.max(a, x), Math.max(b, y)];
      }
    } else return;
    this.drawPrompts();
  }

  clearPrompts() {
    if (this.busy || this.result || this.closing) return;
    this.points = [];
    this.corner = this.box = null;
    this.drawPrompts();
  }

  drawPrompts() {
    for (const name of this.promptLayers) this.viewer.removeLayerByName(name);
    this.promptLayers = [];
    const point = (x, y, color) => {
      const name = `SAM3 prompt ${this.promptLayers.length}`;
      const index = this.viewer.addPointLayer(name, [{ x, y }], { pointColor: color, pointSize: 10 });
      if (index < 0) throw new Error("Cannot display prompt point.");
      this.viewer.setLayerCoordinateSystemPreset(index, "wgs84");
      this.promptLayers.push(name);
    };
    for (const p of this.points) point(p.x, p.y, p.positive ? "#20df80" : "#ff4848");
    if (this.corner) point(...this.corner, "#ffe45a");
    if (this.box) {
      const [a, b, c, d] = this.box;
      const name = "SAM3 prompt box";
      const index = this.viewer.addPolygonLayer(name, [[{ x: a, y: b }, { x: c, y: b }, { x: c, y: d }, { x: a, y: d }, { x: a, y: b }]],
        { fillColor: "#ffe45a", fillOpacity: 24, lineColor: "#ffe45a", lineWidth: 2 });
      if (index < 0) throw new Error("Cannot display prompt box.");
      this.viewer.setLayerCoordinateSystemPreset(index, "wgs84");
      this.promptLayers.push(name);
    }
    this.viewer.setControlValue(SAM.SELECTION, `${this.points.length} points · ${this.box ? "box set" : this.corner ? "choose second corner" : "no box"}`);
    this.viewer.refreshLayers();
  }

  control(id, number, text) {
    if (this.closed || this.closing) return;
    const editable = !this.busy && !this.result;
    if (id === SAM.MODE && editable) { this.textMode = text === "Text segmentation"; this.controls(); }
    else if (id === SAM.TEXT && editable) this.text = String(text || "");
    else if (id === SAM.SCORE && editable) this.score = Math.max(0.01, Math.min(0.99, Number(number)));
    else if (id === SAM.TOOL && editable) { this.mapTool = text; this.controls(); }
    else if (id === SAM.CLEAR) this.clearPrompts();
    else if (id === SAM.ACCEPT) this.accept();
    else if (id === SAM.DISCARD) void this.discard();
    else if (id === SAM.TIFF) void this.saveFormat("geotiff");
    else super.control(id, number, text);
  }

  async run() {
    if (this.busy || this.closing || this.result) return;
    if (this.textMode && !this.text.trim()) { this.log("Enter a concept, for example building."); return; }
    if (!this.textMode && !this.box && !this.points.some(p => p.positive)) { this.log("Add a positive point or a box around one object."); return; }
    const name = this.textMode ? "text" : "tracker";
    const points = this.points.map(p => ({ ...p })), box = this.box && [...this.box];
    const text = this.text.trim(), score = this.score, provider = this.provider;
    await this.execute("start", async () => {
      this.accepted = false;
      if (!this.raster) {
        const prepared = await this.prepareInput();
        this.checkCancelled();
        this.raster = prepared.raster;
        this.viewer.clearLayers();
        this.promptLayers = [];
        this.viewer.setCoordinateSystemPreset("wgs84");
        this.viewer.addLayerFile(prepared.display);
        this.viewer.setCoordinateSystemPreset("wgs84");
        this.viewer.fullExtent();
        this.drawPrompts();
      }
      const manifest = await this.prepare({ url: ROOT + `meta-sam3-${name}-fp32-geokernel-onnx-v1.zip`,
        sha: HASHES[name], required: "sam3-package.json", streaming: true });
      const request = { task: "sam3-" + name, modelPackagePath: path.dirname(manifest), rasterPath: this.raster,
        provider, intraOpThreads: 4, maximumMilliseconds: 1800000 };
      if (name === "text") { request.text = text; request.scoreThreshold = score; }
      else {
        const prompts = await this.prepare({ kind: "sam3-prompts", raster: this.raster, binDir: this.tasks.binDir, points, box });
        request.coordinateSpace = "source-crs";
        request.points = prompts.points;
        if (prompts.box) request.box = prompts.box;
      }
      this.checkCancelled();
      this.job = this.tasks.start(request);
      this.running = true;
      this.progress(0, "Loading SAM3 model…");
    });
  }

  completed(result) {
    this.viewer.addLayerFile(result.vectorPath);
    this.overlay = true;
    this.viewer.setLayerName(0, "SAM3 draft instances");
    this.viewer.setLayerStyle(0, { fillColor: "#ff963f", fillOpacity: 120, lineColor: "#ffd65a", lineWidth: 1.1 });
    this.applyOpacity(this.opacity);
    this.result = result;
    this.accepted = false;
    this.running = this.busy = false;
    this.log(`${result.instances} draft instances\nProvider: ${result.provider}\nPolygons: ${result.polygons}\nElapsed: ${result.elapsedMilliseconds} ms\n\nReview the map, then Accept or Discard.\n${this.legend()}`);
    this.progress(100, "Draft ready. Review, then Accept or Discard.");
    this.controls();
  }

  accept() {
    if (!this.busy && this.result && !this.closing) {
      this.accepted = true;
      this.progress(100, "Draft accepted. Save explicitly to retain it.");
      this.controls();
    }
  }

  async discard() {
    if (this.busy || !this.result || this.closing) return;
    await this.execute("cleanup", async () => {
      this.detachResult();
      this.result = null;
      this.accepted = false;
      await this.releaseJob();
      this.progress(0, "Draft discarded.");
    });
  }

  async save() { await this.saveFormat("shapefile"); }

  async saveFormat(format) {
    if (!this.accepted || this.busy || !this.result || this.closing) return;
    const tiff = format === "geotiff";
    const choice = await dialog.showSaveDialog({ title: "Save accepted SAM3 result", defaultPath: tiff ? "sam3-instances.tif" : "sam3-instances.shp",
      filters: [{ name: tiff ? "GeoTIFF" : "Shapefile", extensions: [tiff ? "tif" : "shp"] }] });
    if (!choice.canceled && choice.filePath) await this.exportTo(choice.filePath, format);
  }

  async exportTo(destination, format = "shapefile") {
    if (!this.accepted || !this.result) return;
    await this.execute("export", async () => {
      await this.job.export(destination, format);
      this.progress(100, "Accepted result saved.");
    });
  }
}

let example;
async function start() { await launch(() => { example = new Sam3SegmentationExample(); return example; }); }
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, Sam3SegmentationExample, ID, SAM };
