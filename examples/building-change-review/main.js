"use strict";
const fs = require("fs"),
  path = require("path"),
  os = require("os");
const { Worker } = require("worker_threads");
const { dialog } = require("electron");
const { launch } = require("../common/geoai-example");
const { sdk } = require("../common/geoai-runtime");
const { ViewerWindow, ViewerTool, ViewerEventType, findBinDir, extent } = sdk();
const core = require("./core"),
  { HOTOSM } = require("../common/geoai-profiles");
const ID = {
  AREA: 1,
  FILTER: 2,
  PROVIDER: 3,
  THRESHOLD: 4,
  RUN: 5,
  CANCEL: 6,
  PROGRESS: 7,
  SUMMARY: 8,
  CANDIDATE: 9,
  SELECTED: 10,
  ACTOR: 11,
  NOTE: 12,
  APPROVE: 13,
  REJECT: 14,
  PENDING: 15,
  LOCATE: 16,
  SAVE: 17,
  OVERLAYS: 18,
};
class BuildingChangeReview {
  constructor() {
    this.bin = findBinDir();
    this.gdal = new core.Gdal(this.bin);
    this.window = new ViewerWindow({
      title: "Building change review — Electron",
      width: 1460,
      height: 860,
      navigationToolbar: false,
      viewerPanes: ["2016 — BEFORE", "2025 — AFTER"],
    });
    this.viewer = this.window;
    this.views = [this.window.pane(0), this.window.pane(1)];
    this.flag = new Int32Array(new SharedArrayBuffer(4));
    this.result = null;
    this.publishedResult = null;
    this.candidatesDirty = false;
    this.candidateStyles = [null, null];
    this.selected = -1;
    this.busy = false;
    this.sourcesReady = false;
    this.closing = false;
    this.closed = false;
    this.overlays = true;
    this.provider = "cpu";
    this.threshold = 0.4371;
    this.area = "Demo area (fixed)";
    this.filter = "Conservative";
    this.actor = "demo-reviewer";
    this.note = "";
    this.syncing = false;
    this.applied = [null, null];
    this.renderBusy = [false, false];
    this.worker = null;
    this.workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "geokernel-change-view-"),
    );
    this.revision = 0;
    this.operation = null;
    this.window.addControlPanel(
      {
        title: "Oosterwold · 2016 → 2025",
        area: "right",
        width: 380,
        controls: [
          {
            id: ID.AREA,
            type: "combo",
            label: "Area",
            options: ["Demo area (fixed)", "Current view", "Full dataset"],
            value: this.area,
          },
          {
            id: ID.FILTER,
            type: "combo",
            label: "Filter",
            options: ["Conservative", "Balanced"],
            value: this.filter,
          },
          {
            id: ID.PROVIDER,
            type: "combo",
            label: "Provider",
            options: ["CPU", "CUDA"],
            value: "CPU",
          },
          {
            id: ID.THRESHOLD,
            type: "number",
            label: "Building threshold",
            minimum: 0.05,
            maximum: 0.95,
            decimals: 4,
            step: 0.025,
            value: this.threshold,
          },
          { id: ID.RUN, type: "button", text: "Run analysis" },
          { id: ID.CANCEL, type: "button", text: "Cancel" },
          { id: ID.PROGRESS, type: "progress", value: 0, format: "%p%" },
          {
            id: ID.SUMMARY,
            type: "text",
            label: "Candidates",
            value: "Preparing imagery…",
          },
          {
            id: ID.CANDIDATE,
            type: "combo",
            label: "Candidate",
            options: [],
            value: "",
          },
          { id: ID.SELECTED, type: "text", label: "Review", value: "" },
          { id: ID.ACTOR, type: "text", label: "Reviewer", value: this.actor },
          { id: ID.NOTE, type: "text", label: "Note", value: "" },
          { id: ID.APPROVE, type: "button", text: "Approve" },
          { id: ID.REJECT, type: "button", text: "Reject" },
          { id: ID.PENDING, type: "button", text: "Pending" },
          { id: ID.LOCATE, type: "button", text: "Locate" },
          { id: ID.SAVE, type: "button", text: "Export approved GeoJSON" },
          {
            id: ID.OVERLAYS,
            type: "checkbox",
            label: "Overlays",
            text: "Show candidate polygons",
            checked: true,
          },
        ],
      },
      (id, number, text) => setImmediate(() => this.control(id, number, text)),
    );
    this.window.addCommandToolbar(
      [
        { id: 101, text: "Zoom in" },
        { id: 102, text: "Zoom out" },
        { id: 103, text: "Demo area" },
        { id: 104, text: "Full extent" },
        { id: 105, text: "Pan" },
        { id: 106, text: "Edit vertices" },
        { id: 107, text: "Undo" },
        { id: 108, text: "Redo" },
        { id: 109, text: "Attribution" },
      ],
      (id) => setImmediate(() => this.command(id)),
    );
    this.views.forEach((v, side) => {
      v.setCoordinateSystemPreset("wgs84");
      v.setTool(ViewerTool.PAN);
      v.setEventCallback((e) => {
        if (e.eventType === ViewerEventType.BUSY_CHANGED)
          this.renderBusy[side] = !!e.intValue;
        if (e.eventType === ViewerEventType.VISIBLE_EXTENT_CHANGED)
          setImmediate(() => this.syncView(side));
      });
    });
    this.timer = setInterval(() => {
      this.window.processEvents();
      if (!this.window.isVisible() && !this.closing) {
        if (this.onHidden) this.onHidden();
        else void this.shutdown();
      }
      if (!this.busy && !this.closing) {
        try {
          if (this.capture()) this.updateControls();
        } catch (e) {
          this.window.setStatusText(e.message);
        }
      }
    }, 50);
    this.window.show();
    this.updateControls();
  }
  progress(percent, message) {
    if (this.closed) return;
    this.window.setControlValue(ID.PROGRESS, percent);
    if (!this.sourcesReady) this.window.setControlValue(ID.SUMMARY, message);
    this.window.setStatusText(message);
  }
  syncView(side) {
    if (this.syncing || this.closing) return;
    const current = this.views[side].getViewExtent();
    const previous = this.applied[side];
    if (
      previous &&
      ["xMin", "yMin", "xMax", "yMax"].every(
        (k) => Math.abs(current[k] - previous[k]) < 1e-10,
      )
    )
      return;
    this.applied[side] = current;
    this.syncing = true;
    try {
      this.views[1 - side].setViewExtent(current);
      this.applied[1 - side] = this.views[1 - side].getViewExtent();
    } finally {
      this.syncing = false;
    }
  }
  updateControls() {
    if (this.closed) return;
    for (const id of [
      ID.AREA,
      ID.FILTER,
      ID.PROVIDER,
      ID.THRESHOLD,
      ID.CANDIDATE,
    ])
      this.window.setControlEnabled(
        id,
        this.sourcesReady && !this.busy && !this.closing,
      );
    this.window.setControlEnabled(ID.RUN, !this.busy && !this.closing);
    for (const id of [ID.APPROVE, ID.REJECT, ID.PENDING, ID.LOCATE])
      this.window.setControlEnabled(
        id,
        !this.busy && !this.closing && this.selected >= 0,
      );
    this.window.setControlEnabled(ID.CANCEL, this.busy && !this.closing);
    this.window.setControlEnabled(
      ID.SAVE,
      !this.busy &&
        !this.closing &&
        !!this.result?.features.some(
          (f) => f.properties.review_status === "approved",
        ),
    );
    if (this.result) {
      this.window.setControlValue(
        ID.SUMMARY,
        `${this.result.features.filter((f) => f.properties.change_type === "new").length} new · ${this.result.features.filter((f) => f.properties.change_type === "removed").length} removed`,
      );
      if (this.selected >= 0) {
        const f = this.result.features[this.selected];
        this.window.setControlValue(
          ID.SELECTED,
          `${f.properties.area_m2.toFixed(1)} m² · ${f.properties.review_status}`,
        );
      }
    }
  }
  check() {
    if (Atomics.load(this.flag, 0) || this.closing) throw Error("Cancelled.");
  }
  prepareAsset(asset) {
    return new Promise((resolve, reject) => {
      const w = new Worker(
        path.join(__dirname, "../common/geoai-assets-worker.js"),
        { workerData: { asset, cancellation: this.flag.buffer } },
      );
      let value, error;
      w.on("message", (m) => {
        if (m.result) value = m.result;
        else if (m.error) error = Error(m.error);
        else this.progress(m.percent, m.message);
      });
      w.on("error", (e) => {
        error = e;
      });
      w.on("exit", (code) =>
        error
          ? reject(error)
          : code || !value
            ? reject(Error(`Asset worker exited (${code}).`))
            : resolve(value),
      );
    });
  }
  async execute(action) {
    if (this.busy || this.closing) return;
    this.busy = true;
    Atomics.store(this.flag, 0, 0);
    this.updateControls();
    this.operation = (async () => {
      try {
        await action();
      } catch (e) {
        if (!this.closing) {
          this.window.setStatusText(e.message);
          if (!this.sourcesReady)
            this.window.setControlValue(
              ID.SUMMARY,
              "Loading failed; click Run analysis to retry.",
            );
        }
      } finally {
        this.busy = false;
        this.updateControls();
      }
    })();
    await this.operation;
  }
  async initialize() {
    if (this.sourcesReady) return;
    await this.execute(async () => {
      try {
        this.progress(0, "Preparing imagery…");
        const first = await this.prepareAsset(core.DATA);
        const paths = [first, path.join(path.dirname(first), core.FILES[1])];
        for (let i = 0; i < 2; i++)
          if (core.fileHash(paths[i]) !== core.HASHES[i])
            throw Error("Imagery SHA-256 mismatch.");
        const model = path.dirname(await this.prepareAsset(HOTOSM.model));
        const displays = await this.runWorker(
          {
            bin: this.bin,
            paths,
            destinations: paths.map((_, i) =>
              path.join(this.workspace, `display-${i}.tif`),
            ),
          },
          "prepare-display",
        );
        this.check();
        this.views.forEach((v, i) => {
          v.addLayerFile(displays[i]);
          v.setLayerName(0, "Imagery");
          const e = v.layerProjectedExtent(0);
          if (
            !e ||
            ![e.xMin, e.yMin, e.xMax, e.yMax].every(Number.isFinite) ||
            e.xMin < -180 ||
            e.xMax > 180 ||
            e.yMin < -90 ||
            e.yMax > 90 ||
            e.xMin >= e.xMax ||
            e.yMin >= e.yMax
          )
            throw Error("Imagery did not load in WGS84.");
        });
        this.focus(core.DEMO);
        // Publish inputs only after both display layers are loaded successfully.
        this.paths = paths;
        this.displays = displays;
        this.model = model;
        this.sourcesReady = true;
        this.window.setControlValue(
          ID.SUMMARY,
          "Run analysis to find candidates.",
        );
        this.progress(0, "Ready · Beeldmateriaal / PDOK · CC BY 4.0");
      } catch (e) {
        this.views.forEach((v) => v.clearLayers());
        await new Promise((resolve) => setTimeout(resolve, 200));
        while (this.renderBusy.some(Boolean))
          await new Promise((resolve) => setTimeout(resolve, 50));
        throw e;
      }
    });
  }
  runWorker(options, mode = "analysis") {
    return new Promise((resolve, reject) => {
      let value, error;
      const w = new Worker(path.join(__dirname, "worker.js"), {
        workerData: { mode, options, cancellation: this.flag.buffer },
      });
      this.worker = w;
      w.on("message", (m) => {
        if (m.result) value = m.result;
        else if (m.error) error = Error(m.error);
        else this.progress(m.percent, m.message);
      });
      w.on("error", (e) => {
        error = e;
      });
      w.on("exit", (code) => {
        this.worker = null;
        error
          ? reject(error)
          : code || !value
            ? reject(Error(`Worker exited (${code}).`))
            : resolve(value);
      });
    });
  }
  focus(bounds) {
    const b = core.envelope(
      this.gdal.geometry(core.rectangle(bounds), 25831, 4326).geometry,
    );
    this.views[0].setViewExtent(extent(...b));
  }
  async run() {
    if (!this.sourcesReady) return this.initialize();
    this.capture();
    if (this.result) {
      const r = await dialog.showMessageBox({
        type: "question",
        message: "Replace this session’s candidates and review decisions?",
        buttons: ["Cancel", "Run"],
        defaultId: 0,
        cancelId: 0,
      });
      if (r.response !== 1) return;
    }
    await this.execute(async () => {
      let bounds = this.area === "Full dataset" ? core.BOUNDS : core.DEMO;
      if (this.area === "Current view") {
        const e = this.views[0].getViewExtent();
        bounds = core.envelope(
          this.gdal.geometry(core.rectangle([e.xMin, e.yMin, e.xMax, e.yMax]))
            .geometry,
        );
      }
      const options = {
        paths: this.paths,
        model: this.model,
        bounds,
        policy: core.PROFILES[this.filter],
        threshold: this.threshold,
        provider: this.provider,
        bin: this.bin,
      };
      const result = await this.runWorker(options);
      this.check();
      this.result = result;
      this.selected = result.features.length ? 0 : -1;
      this.window.setControlOptions(
        ID.CANDIDATE,
        result.features.map((f) => f.id),
      );
      if (this.selected >= 0)
        this.window.setControlValue(ID.CANDIDATE, result.features[0].id);
      this.redraw();
      this.progress(100, "Complete · predictions require review");
    });
  }
  write(features) {
    const file = path.join(
      this.workspace,
      `overlay-${++this.revision}.geojson`,
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "FeatureCollection", features }),
    );
    return file;
  }
  redraw() {
    if (!this.overlays) return;
    if (this.publishedResult !== this.result || this.candidatesDirty)
      this.endEdit();
    this.ensureCandidates();
    this.updateSelection();
  }
  layerIndex(viewer, name) {
    const info = viewer.layerInfoByName(name);
    return info.isValid ? info.index : -1;
  }
  ensureCandidates() {
    if (this.publishedResult === this.result && !this.candidatesDirty) return;
    this.views.forEach((v, side) => {
      while (v.removeLayerByName("Candidates")) {}
      while (v.removeLayerByName("Selection targets")) {}
      this.candidateStyles[side] = null;
      if (!this.result) return;
      const targets = structuredClone(this.result.features);
      if (!side)
        targets.forEach((f) => {
          f.geometry = core.rectangle(core.envelope(f.geometry));
        });
      if (targets.length) {
        v.addLayerFile(this.write(targets));
        v.setLayerName(0, "Selection targets");
        v.setLayerStyle(0, {
          fillOpacity: 0,
          lineColor: "#00000000",
          lineWidth: 0,
          selectedLineColor: "#ef9b00",
          selectedLineWidth: 2,
        });
      }
      const kind = side ? "new" : "removed";
      const features = this.result.features.filter(
        (f) => f.properties.change_type === kind,
      );
      if (features.length) {
        v.addLayerFile(this.write(features));
        v.setLayerName(0, "Candidates");
      }
    });
    this.publishedResult = this.result;
    this.candidatesDirty = false;
    this.applyCandidateStyles();
  }
  applyCandidateStyles() {
    if (!this.result) return;
    this.views.forEach((v, side) => {
      const index = this.layerIndex(v, "Candidates");
      if (index < 0) return;
      const kind = side ? "new" : "removed";
      const color = side ? "#20bf73" : "#ee554f";
      const rules = this.result.features
        .filter(
          (f) =>
            f.properties.change_type === kind &&
            f.properties.review_status !== "pending",
        )
        .map((f) => ({
          field: "candidate_id",
          operator: "equals",
          value: f.id,
          style:
            f.properties.review_status === "approved"
              ? {
                  fillColor: color,
                  lineColor: color,
                  fillOpacity: 90,
                  lineWidth: 3,
                }
              : {
                  fillColor: "#82909f",
                  lineColor: "#82909f",
                  fillOpacity: 10,
                  lineWidth: 1,
                },
        }));
      const renderer = {
        type: "ruleBased",
        defaultStyle: {
          fillColor: color,
          lineColor: color,
          fillOpacity: 35,
          lineWidth: 2,
        },
        rules,
      };
      const key = JSON.stringify(renderer);
      if (this.candidateStyles[side] !== key) {
        if (!v.setLayerSymbolRenderer(index, renderer))
          throw Error("Cannot style candidates.");
        this.candidateStyles[side] = key;
      }
    });
  }
  highlight(viewer, layer, geometry, candidateId) {
    if (layer < 0) throw Error("Selection references are unavailable.");
    const [a, b, c, d] = core.envelope(geometry);
    const hit = viewer
      ._readJson("GeoKernelViewer_HitTestFeaturesInExtentJson", [], a, b, c, d)
      .find(
        (h) =>
          h.layerIndex === layer &&
          (candidateId === undefined ||
            h.attributes?.candidate_id === candidateId),
      );
    if (!hit) throw Error("Cannot find selected candidate.");
    // A concave roof may not contain its envelope centre. Identify the exact
    // feature and use a tolerance covering the envelope.
    if (
      !viewer.selectFeatureHit(
        { ...hit, worldPoint: { x: (a + c) / 2, y: (b + d) / 2 } },
        Math.max(c - a, d - b, 1e-9) * 2,
      )
    )
      throw Error("Cannot highlight selected candidate.");
  }
  updateSelection() {
    this.views.forEach((v, side) => {
      if (!this.overlays || !this.result || this.selected < 0) {
        v.clearSelectedFeatures();
        return;
      }
      for (const name of ["Candidates", "Selection targets", "Selection"]) {
        const info = v.layerInfoByName(name);
        if (info.isValid && !info.visible) v.setLayerVisible(info.index, true);
      }
      const f = this.result.features[this.selected];
      const geometry = side
        ? f.geometry
        : core.rectangle(core.envelope(f.geometry));
      const editor = side ? this.layerIndex(v, "Selection") : -1;
      this.highlight(
        v,
        editor >= 0 ? editor : this.layerIndex(v, "Selection targets"),
        geometry,
        editor >= 0 ? undefined : f.id,
      );
    });
  }
  endEdit() {
    const v = this.views[1];
    if (this.layerIndex(v, "Selection") >= 0) {
      v.clearSelectedFeatures();
      v.removeLayerByName("Selection");
      v.setTool(ViewerTool.PAN);
    }
  }
  useTool(tool) {
    if (tool === ViewerTool.EDIT_VERTICES) {
      if (!this.overlays || !this.result || this.selected < 0)
        throw Error("Select a visible candidate before editing.");
      const v = this.views[1];
      if (this.layerIndex(v, "Selection") < 0) {
        const geometry = this.result.features[this.selected].geometry;
        if (geometry.type !== "Polygon")
          throw Error(
            "Multipart geometry is preserved but cannot be edited in this example.",
          );
        v.clearSelectedFeatures();
        const index = v.addPolygonLayer("Selection", geometry.coordinates, {
          fillOpacity: 0,
          lineColor: "#ef9b00",
          lineWidth: 2,
          selectedLineColor: "#ef9b00",
          selectedLineWidth: 2,
        });
        if (
          index < 0 ||
          !v.beginEditLayer(index) ||
          !v.setActiveEditLayerIndex(index)
        )
          throw Error("Cannot edit selected candidate.");
        this.highlight(v, index, geometry);
      }
    }
    this.views[1].setTool(tool);
  }
  capture() {
    if (!this.result || this.selected < 0 || !this.overlays) return false;
    const v = this.views[1];
    const index = this.layerIndex(v, "Selection");
    if (index < 0 || !v.isLayerEditing(index)) return false;
    const value = JSON.parse(v.writeLayerLastShapeGeoJson(index));
    const f = this.result.features[this.selected];
    const previousStatus = f.properties.review_status;
    const changed = core.update(f, value.geometry || value, this.gdal);
    if (changed) {
      this.candidatesDirty = true;
      if (previousStatus !== "pending") this.applyCandidateStyles();
    }
    return changed;
  }
  select(index) {
    if (this.busy || index < 0 || index === this.selected) return;
    this.capture();
    this.endEdit();
    const previous = this.selected;
    this.selected = index;
    try {
      this.redraw();
    } catch (e) {
      this.selected = previous;
      throw e;
    }
    this.note = this.result.features[index].properties.review_note;
    this.window.setControlValue(ID.NOTE, this.note);
    this.updateControls();
  }
  locate() {
    if (this.selected < 0) return;
    const [a, b, c, d] = core.envelope(
        this.result.features[this.selected].geometry,
      ),
      dx = Math.max(0.00015, (c - a) * 0.5),
      dy = Math.max(0.00015, (d - b) * 0.5);
    this.views[0].setViewExtent(extent(a - dx, b - dy, c + dx, d + dy));
  }
  async save() {
    this.capture();
    const r = await dialog.showSaveDialog({
      title: "Export approved candidates",
      defaultPath: "building_changes.geojson",
      filters: [{ name: "GeoJSON", extensions: ["geojson"] }],
    });
    if (!r.canceled && r.filePath)
      core.exportApproved(this.result, r.filePath, this.gdal);
  }
  async control(id, number, text) {
    try {
      if (id === ID.AREA) this.area = text;
      else if (id === ID.FILTER) this.filter = text;
      else if (id === ID.PROVIDER) this.provider = text.toLowerCase();
      else if (id === ID.THRESHOLD) this.threshold = number;
      else if (id === ID.ACTOR) this.actor = text;
      else if (id === ID.NOTE) this.note = text;
      else if (id === ID.CANCEL) Atomics.store(this.flag, 0, 1);
      else if (id === ID.RUN) await this.run();
      else if (id === ID.CANDIDATE && this.result)
        this.select(this.result.features.findIndex((f) => f.id === text));
      else if ([ID.APPROVE, ID.REJECT, ID.PENDING].includes(id)) {
        this.capture();
        core.review(
          this.result.features[this.selected],
          id === ID.APPROVE
            ? "approved"
            : id === ID.REJECT
              ? "rejected"
              : "pending",
          this.actor,
          this.note,
          this.gdal,
        );
        this.applyCandidateStyles();
        this.updateControls();
      } else if (id === ID.LOCATE) this.locate();
      else if (id === ID.SAVE) await this.save();
      else if (id === ID.OVERLAYS) {
        this.capture();
        this.overlays = !!number;
        if (this.overlays) this.redraw();
        else
          this.views.forEach((v) => {
            v.clearSelectedFeatures();
            for (const name of [
              "Selection",
              "Selection targets",
              "Candidates",
            ]) {
              const index = this.layerIndex(v, name);
              if (index >= 0) v.setLayerVisible(index, false);
            }
          });
      }
    } catch (e) {
      if (id === ID.CANDIDATE && this.selected >= 0)
        this.window.setControlValue(
          ID.CANDIDATE,
          this.result.features[this.selected].id,
        );
      if (id === ID.OVERLAYS)
        this.window.setControlValue(ID.OVERLAYS, this.overlays ? 1 : 0);
      this.window.setStatusText(e.message);
    }
  }
  async command(id) {
    try {
      if (id === 101) this.views[0].zoomIn();
      if (id === 102) this.views[0].zoomOut();
      if (id === 103) this.focus(core.DEMO);
      if (id === 104) this.focus(core.BOUNDS);
      if (id === 105) this.useTool(ViewerTool.PAN);
      if (id === 106) this.useTool(ViewerTool.EDIT_VERTICES);
      if (id === 107 || id === 108) {
        const index = this.layerIndex(this.views[1], "Selection");
        if (this.overlays && index >= 0) {
          if (id === 107) this.views[1].undoEditLayer(index);
          else this.views[1].redoEditLayer(index);
          this.capture();
          this.updateControls();
        }
      }
      if (id === 109)
        await dialog.showMessageBox({
          type: "info",
          message: core.ATTRIBUTION,
          detail:
            "https://www.beeldmateriaal.nl/dataroom\nhttps://creativecommons.org/licenses/by/4.0/",
        });
    } catch (e) {
      this.window.setStatusText(e.message);
    }
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    Atomics.store(this.flag, 0, 1);
    this.updateControls();
    this.shutdownPromise = (async () => {
      await this.operation;
      this.views.forEach((v) => v.clearLayers());
      await new Promise((resolve) => setTimeout(resolve, 200));
      while (this.renderBusy.some(Boolean))
        await new Promise((resolve) => setTimeout(resolve, 50));
      clearInterval(this.timer);
      this.views.forEach((v) => v.setEventCallback(null));
      this.window.close();
      this.closed = true;
      const resolved = path.resolve(this.workspace);
      if (
        path.dirname(resolved) === path.resolve(os.tmpdir()) &&
        path.basename(resolved).startsWith("geokernel-change-view-")
      )
        fs.rmSync(resolved, { recursive: true, force: true });
    })();
    return this.shutdownPromise;
  }
}
let example;
async function start() {
  example = await launch(() => new BuildingChangeReview());
}
async function stop() {
  if (example) await example.shutdown();
}
module.exports = { start, stop, BuildingChangeReview, ID };
