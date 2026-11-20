"use strict";
const element = (id) => document.getElementById(id);
const api = window.processingApi;
const KEYS = ["working", "window", "threshold", "slope", "terrain", "retain"];
const CHANGED = "Controls changed. Run to update; displayed result and scores still use the last completed run.";
let presets = [], state = { busy: true, hasScene: false, hasRun: false };

function applyState(next) {
  state = next;
  const idle = !state.busy;
  for (const button of document.querySelectorAll(".toolbar button")) button.disabled = !idle || !state.hasScene;
  for (const id of ["sample", "open", "preset", ...KEYS]) element(id).disabled = !idle;
  element("run").disabled = element("reference").disabled = !idle || !state.hasScene;
  element("save").disabled = element("mode").disabled = !idle || !state.hasRun;
  element("cancel").disabled = !state.busy;
  const progress = element("progress");
  progress.hidden = !state.busy;
  if (Number.isFinite(state.percent)) progress.value = state.percent;
}

// The native maps are child windows; report where the page wants them.
function layout() {
  api.action("layout", ["view0", "view1", "view2"].map((id) => {
    const r = element(id).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }));
}
for (const id of ["view0", "view1", "view2"]) new ResizeObserver(layout).observe(element(id));
window.addEventListener("resize", layout);

function changed() {
  if (state.hasRun) element("state").textContent = CHANGED;
}

function applyPreset(index) {
  const p = presets[index];
  if (!p) return;
  for (const key of KEYS) element(key).value = String(p[key]);
  changed();
}

function run() {
  const values = {};
  for (const key of KEYS) {
    // Step sizes are arrow increments only (as in the Qt spin boxes), so only range and format are checked.
    const input = element(key), v = input.validity;
    if (v.badInput || v.valueMissing || v.rangeUnderflow || v.rangeOverflow) { input.reportValidity(); return; }
    values[key] = Number(input.value);
  }
  api.action("run", values);
}

for (const button of document.querySelectorAll("[data-tool]")) {
  button.onclick = () => {
    for (const other of document.querySelectorAll("[data-tool]")) other.classList.toggle("on", other === button);
    api.action("tool", button.dataset.tool);
  };
}
for (const button of document.querySelectorAll("[data-zoom]")) button.onclick = () => api.action("zoom", button.dataset.zoom);
for (const key of KEYS) element(key).onchange = changed;
element("preset").onchange = () => applyPreset(Number(element("preset").value));
element("sample").onclick = () => api.action("sample");
element("open").onclick = () => api.action("open");
element("reference").onclick = () => api.action("reference");
element("run").onclick = run;
element("cancel").onclick = () => api.action("cancel");
element("mode").onchange = () => api.action("mode", Number(element("mode").value));
element("save").onclick = () => api.action("save");

api.onInit((value) => {
  presets = value.presets;
  element("preset").replaceChildren(...value.names.map((name, i) => new Option(name, String(i))));
  document.querySelector("[data-tool=pan]").classList.add("on");
  layout();
  api.action("sample");
});
api.onStatus((next) => { element("status").textContent = next.message; applyState(next); });
api.onScene((value) => {
  element("source").textContent = value.source;
  element("metrics").textContent = value.metrics;
  element("summary").textContent = value.summary;
  element("heading1").textContent = value.headings[0];
  element("heading2").textContent = value.headings[1];
  if (value.legend) element("legend").textContent = value.legend;
  element("state").textContent = value.state;
});
api.onDisplay((value) => {
  element("heading1").textContent = value.headings[0];
  element("heading2").textContent = value.headings[1];
  element("legend").textContent = value.legend;
});
api.onMode((value) => { element("mode").value = String(value); });
api.onProbe((text) => { element("probe").textContent = text; });
api.onState((text) => { element("state").textContent = text; });
