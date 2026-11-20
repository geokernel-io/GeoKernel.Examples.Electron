"use strict";
const element = (id) => document.getElementById(id);
const api = window.aiApi;
const CHANGED = "Controls changed. Run to update; displayed maps and scores use the last completed settings.";
let state = { busy: true, hasScene: false, hasModel: false, hasComparison: false };

function applyState(next) {
  state = next;
  const idle = !state.busy;
  for (const button of document.querySelectorAll(".toolbar button")) button.disabled = !idle || !state.hasScene;
  for (const id of ["sample", "open", "model", "zip", "overlap", "threads", "preset", "scope"]) element(id).disabled = !idle;
  element("run").disabled = !idle || !state.hasScene || !state.hasModel;
  element("reference").disabled = !idle || !state.hasScene;
  element("save").disabled = element("mode").disabled = !idle || !state.hasComparison;
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
  if (state.hasComparison) element("state").textContent = CHANGED;
}

function run() {
  // Step sizes are arrow increments only (as in the Qt spin boxes), so only range and format are checked.
  for (const id of ["overlap", "threads"]) {
    const input = element(id), v = input.validity;
    if (v.badInput || v.valueMissing || v.rangeUnderflow || v.rangeOverflow || !Number.isInteger(Number(input.value))) { input.reportValidity(); return; }
  }
  api.action("run", { overlap: Number(element("overlap").value), threads: Number(element("threads").value), preset: Number(element("preset").value) });
}

for (const button of document.querySelectorAll("[data-tool]")) {
  button.onclick = () => {
    for (const other of document.querySelectorAll("[data-tool]")) other.classList.toggle("on", other === button);
    api.action("tool", button.dataset.tool);
  };
}
for (const button of document.querySelectorAll("[data-zoom]")) button.onclick = () => api.action("zoom", button.dataset.zoom);
for (const id of ["overlap", "threads", "preset"]) element(id).onchange = changed;
element("sample").onclick = () => api.action("sample");
element("open").onclick = () => api.action("open");
element("reference").onclick = () => api.action("reference");
element("model").onclick = () => api.action("model");
element("zip").onclick = () => api.action("zip");
element("run").onclick = run;
element("cancel").onclick = () => api.action("cancel");
element("mode").onchange = () => api.action("mode", Number(element("mode").value));
element("scope").onchange = () => api.action("scope", Number(element("scope").value));
element("save").onclick = () => api.action("save");

api.onInit((value) => {
  element("preset").replaceChildren(...value.names.map((name, i) => new Option(name, String(i))));
  document.querySelector("[data-tool=pan]").classList.add("on");
  layout();
  api.action("sample");
});
api.onStatus((next) => { element("status").textContent = next.message; applyState(next); });
api.onScene((value) => {
  if (value.source) element("source").textContent = value.source;
  if (value.headings) { element("heading1").textContent = value.headings[0]; element("heading2").textContent = value.headings[1]; }
  element("summary").textContent = value.summary;
  const rows = element("scores").tBodies[0].rows;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) rows[r].cells[c].textContent = value.rows ? value.rows[r][c] : "";
});
api.onDisplay((value) => {
  element("heading1").textContent = value.headings[0];
  element("heading2").textContent = value.headings[1];
  element("legend").textContent = value.legend;
});
api.onMode((value) => { element("mode").value = String(value); });
api.onModel((text) => { element("modelInfo").textContent = text; });
api.onProbe((text) => { element("probe").textContent = text; });
api.onState((text) => { element("state").textContent = text; });
