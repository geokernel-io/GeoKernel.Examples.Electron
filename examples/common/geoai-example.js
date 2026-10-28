"use strict";

const path = require("path");
const { Worker } = require("worker_threads");
const { app, BrowserWindow, dialog } = require("electron");
const { sdk } = require("./geoai-runtime");
const { AITasks, ViewerWindow, ViewerTool, ViewerEventType } = sdk();
const ID = { PROVIDER: 1, OPACITY: 2, RUN: 3, SAVE: 4, CANCEL: 5, PROGRESS: 6, STAGE: 7, THRESHOLD: 8 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class GeoAiExample {
  constructor(profile) {
    this.profile = profile;
    this.threshold = 0.50;
    this.tasks = new AITasks();
    this.viewer = new ViewerWindow({ title: profile.title, width: 1280, height: 850, navigationToolbar: true });
    this.job = null;
    this.result = null;
    this.raster = null;
    this.overlay = false;
    this.busy = false;
    this.running = false;
    this.closing = false;
    this.closed = false;
    this.renderBusy = false;
    this.lastIdle = Date.now();
    this.provider = "auto";
    this.opacity = profile.buildings ? 100 : 60;
    this.cancellation = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.cancellation);
    this.operation = null;
    this.stage = "";
    this.viewer.addControlPanel({ title: profile.title, area: "right", width: 390, controls: [
      { id: ID.PROVIDER, type: "combo", label: "Execution provider", options: ["Auto", "CPU", "CUDA"], value: "Auto" },
      ...(profile.controls || []),
      ...(profile.buildings ? [{ id: ID.THRESHOLD, type: "number", label: profile.thresholdLabel || "Building threshold",
        minimum: 0.01, maximum: 0.99, step: 0.05, decimals: 2, value: 0.50 }] : []),
      { id: ID.OPACITY, type: "slider", label: profile.opacityLabel || "Output opacity (right = opaque)", minimum: 0, maximum: 100, value: this.opacity },
      { id: ID.RUN, type: "button", text: profile.runLabel },
      { id: ID.SAVE, type: "button", text: profile.saveLabel || "Save Shapefile" },
      { id: ID.CANCEL, type: "button", text: "Cancel inference" },
      { id: ID.PROGRESS, type: "progress", value: 0, format: "%p%" },
      { id: ID.STAGE, type: "text", label: "Status", value: "Preparing source…" },
    ] }, (id, number, text) => setImmediate(() => this.control(id, number, text)));
    this.viewer.addLogPanel("Inference diagnostics / classes");
    this.viewer.setTool(ViewerTool.PAN);
    this.viewer.setEventCallback(event => {
      if (event.eventType === ViewerEventType.BUSY_CHANGED) {
        this.renderBusy = !!event.intValue;
        if (!this.renderBusy) this.lastIdle = Date.now();
      }
      if (event.eventType === ViewerEventType.DRAWING_PROGRESS_CHANGED && !this.busy && !this.closing) {
        this.viewer.setStatusText((event.text || "Drawing…").replaceAll("%p%", `${event.intValue}%`));
      }
      if (this.handleMapEvent) this.handleMapEvent(event);
    });
    this.pump = setInterval(() => this.tick(), 16);
    this.controls();
  }

  controls() {
    if (this.closed) return;
    this.viewer.setControlEnabled(ID.RUN, !this.busy && !this.closing);
    this.viewer.setControlEnabled(ID.PROVIDER, !this.busy && !this.closing);
    if (this.profile.buildings) this.viewer.setControlEnabled(ID.THRESHOLD, !this.busy && !this.closing);
    this.viewer.setControlEnabled(ID.SAVE, !!this.result && !this.busy && !this.closing);
    this.viewer.setControlEnabled(ID.CANCEL, this.busy && this.stage !== "export" && !this.closing);
    this.viewer.setControlEnabled(ID.OPACITY, this.overlay && !this.closing);
  }

  progress(percent, text) {
    if (this.closed) return;
    percent = Math.max(0, Math.min(100, Math.round(percent || 0)));
    text = String(text).replaceAll("%p%", `${percent}%`);
    this.viewer.setControlValue(ID.PROGRESS, percent);
    this.viewer.setControlValue(ID.STAGE, text);
    this.viewer.setStatusText(`${percent}% — ${text}`);
  }

  log(text) { this.viewer.clearLog(); this.viewer.appendLog(text); }

  prepare(asset) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "geoai-assets-worker.js"), {
        workerData: { asset, cancellation: this.cancellation },
      });
      let result, error;
      worker.on("message", message => {
        if (message.result) result = message.result;
        else if (message.error) error = new Error(message.error);
        else this.progress(message.percent, message.message);
      });
      worker.on("error", value => { error = value; });
      worker.on("exit", code => {
        if (error) reject(error);
        else if (code || !result) reject(new Error(`Asset worker exited (${code}).`));
        else resolve(result);
      });
    });
  }

  checkCancelled() { if (Atomics.load(this.flag, 0) || this.closing) throw new Error("Cancelled."); }

  async execute(stage, action) {
    if (this.busy || this.closing) return;
    this.busy = true;
    this.stage = stage;
    Atomics.store(this.flag, 0, 0);
    this.controls();
    this.operation = (async () => {
      try { await action(); }
      catch (error) {
        this.log(error.message);
        this.progress(0, error.message === "Cancelled." ? "Cancelled." : "Operation failed; see diagnostics.");
        if (!this.result && this.job) await this.releaseJob();
      } finally {
        if (!this.running) this.busy = false;
        this.controls();
      }
    })();
    await this.operation;
  }

  async initialize() {
    await this.execute("prepare", async () => {
      const { raster, display } = await this.prepareInput();
      this.checkCancelled();
      this.raster = raster;
      this.viewer.clearLayers();
      this.viewer.addLayerFile(display);
      this.viewer.setLayerName(0, this.profile.sourceName);
      this.viewer.fullExtent();
      this.log(this.profile.description + "\nClick Run. No predictions are loaded at startup.\n\n" + this.legend());
      this.progress(0, "Ready. Click Run to process the image.");
    });
  }

  legend() { return this.profile.legend; }

  async prepareInput() {
    const raster = await this.prepare(this.profile.data);
    this.checkCancelled();
    const display = this.profile.spectralPreview
      ? await this.prepare({ kind: this.profile.spectralPreview, raster, sha: this.profile.data.sha, binDir: this.tasks.binDir })
      : path.join(path.dirname(raster), this.profile.displayName);
    this.checkCancelled();
    return { raster, display };
  }

  async run() {
    await this.execute("start", async () => {
      this.detachResult();
      this.result = null;
      await this.releaseJob();
      if (!this.raster) {
        const { raster, display } = await this.prepareInput();
        this.checkCancelled();
        this.raster = raster;
        this.viewer.clearLayers();
        this.viewer.addLayerFile(display);
        this.viewer.fullExtent();
      }
      const manifest = await this.prepare(this.profile.model);
      this.checkCancelled();
      const request = { task: this.profile.task, modelPackagePath: path.dirname(manifest), rasterPath: this.raster,
        provider: this.provider, intraOpThreads: 4, maximumMilliseconds: 600000 };
      if (this.profile.buildings) request.threshold = this.threshold;
      else if (this.profile.task === "dynamic-world") request.validityMaskPath = path.join(path.dirname(this.raster), "dynamicworld_spain_valid_mask.tif");
      this.job = this.tasks.start(request);
      this.running = true;
      this.progress(0, "Running inference…");
    });
  }

  detachResult() {
    if (this.overlay) this.viewer.removeLayer(0);
    this.overlay = false;
  }

  async renderFence() {
    await pause(32);
    const deadline = Date.now() + 60000;
    while (this.renderBusy || Date.now() - this.lastIdle < 16) {
      if (Date.now() > deadline) throw new Error("Renderer is still using the result; release deferred.");
      await pause(16);
    }
  }

  async releaseJob() {
    if (!this.job) return;
    await this.renderFence();
    const job = this.job;
    await job.close();
    this.job = null;
  }

  cancel() {
    Atomics.store(this.flag, 0, 1);
    if (!this.job || this.stage === "export") return;
    if (["queued", "running", "cancelling"].includes(this.job.status().state)) {
      try { this.job.cancel(); }
      catch (error) { if (!["completed", "failed", "cancelled"].includes(this.job.status().state)) throw error; }
    }
  }

  applyOpacity(value) {
    this.opacity = Math.max(0, Math.min(100, Number(value)));
    if (this.overlay) {
      if (this.profile.buildings) {
        require("./geoai-vector").applyVectorOpacity(this.viewer, this.opacity);
        return;
      }
      this.viewer.setLayerOpacity(0, this.opacity / 100);
      this.viewer.refreshLayers();
    }
  }

  async save() {
    if (this.busy || !this.result || this.closing) return;
    const choice = await dialog.showSaveDialog({ title: "Save polygons", defaultPath: this.profile.exportName,
      filters: [{ name: "Shapefile", extensions: ["shp"] }] });
    if (!choice.canceled && choice.filePath) await this.exportTo(choice.filePath);
  }

  async exportTo(destination) {
    if (!this.result) return;
    await this.execute("export", async () => {
      await this.job.export(destination, "shapefile");
      this.progress(100, "Shapefile saved.");
    });
  }

  control(id, number, text) {
    if (this.closing || this.closed) return;
    if (id === ID.OPACITY) this.applyOpacity(number);
    else if (id === ID.PROVIDER && !this.busy) this.provider = String(text).toLowerCase();
    else if (id === ID.THRESHOLD && this.profile.buildings && !this.busy) this.threshold = Math.max(0.01, Math.min(0.99, Number(number)));
    else if (id === ID.RUN) void this.run();
    else if (id === ID.SAVE) void this.save();
    else if (id === ID.CANCEL) this.cancel();
  }

  tick() {
    if (this.closed || this.inTick) return;
    this.inTick = true;
    try {
      this.viewer.processEvents();
      if (!this.closing && this.onHidden && !this.viewer.isVisible()) this.onHidden();
      if (!this.running || this.closing) return;
      const status = this.job.status();
      this.progress(status.percent, status.message);
      if (status.state === "completed" && !Atomics.load(this.flag, 0)) {
        this.completed(this.job.result());
      } else if (["failed", "cancelled", "completed"].includes(status.state)) {
        throw new Error(status.state === "failed" ? status.error : "Cancelled.");
      }
    } catch (error) {
      this.running = this.busy = false;
      void this.execute("cleanup", async () => {
        this.detachResult();
        this.result = null;
        await this.releaseJob();
        this.log(error.message);
        this.progress(0, error.message === "Cancelled." ? "Cancelled." : "Inference failed; see diagnostics.");
      });
    } finally { this.inTick = false; }
  }

  completed(result) {
    if (this.profile.buildings) {
      this.running = this.busy = false;
      void this.execute("preview", async () => {
        const preview = await this.prepare({ kind: "vector-preview", vectorPath: result.vectorPath, binDir: this.tasks.binDir });
        this.checkCancelled();
        this.showCompleted(result, preview);
      });
      return;
    }
    this.showCompleted(result, result.previewPath);
  }

  showCompleted(result, preview) {
    this.viewer.addLayerFile(preview);
    this.overlay = true;
    this.viewer.setLayerName(0, this.profile.title);
    this.applyOpacity(this.opacity);
    this.result = result;
    this.running = this.busy = false;
    this.log(`Provider: ${result.provider}\nPolygons: ${result.polygons}\nElapsed: ${result.elapsedMilliseconds} ms\n\nSession-only result. Save Shapefile to retain it.\n${this.profile.buildings ? `Instances: ${result.instances} · threshold: ${this.threshold.toFixed(2)}` : this.profile.interpretation || "Water class 0 is valid; NoData is excluded."}\n\n${this.legend()}`);
    this.progress(100, "Inference complete.");
    this.controls();
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.cancel();
    this.controls();
    this.shutdownPromise = (async () => {
      if (this.operation) await this.operation;
      this.running = false;
      this.viewer.clearLayers();
      this.overlay = false;
      this.result = null;
      await this.releaseJob();
      clearInterval(this.pump);
      this.viewer.setEventCallback(null);
      this.viewer.close();
      this.closed = true;
    })();
    return this.shutdownPromise;
  }
}


async function launch(createExample) {
  const keeper = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  // Initialize Electron/OLE before the native Qt window, matching the other native-window examples.
  const example = createExample();
  example.viewer.show();
  example.onHidden = () => app.quit();
  app.on("before-quit", event => {
    if (!example.closed) {
      event.preventDefault();
      void example.shutdown().then(() => { keeper.destroy(); app.quit(); });
    }
  });
  await example.initialize();
  return example;
}
module.exports = { GeoAiExample, launch, ID };
