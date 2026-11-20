"use strict";
const element = (id) => document.getElementById(id);
const COLORS = ["#66768a", "#087e8b", "#8857bd", "#d98419"];
let ready = false, busy = true, sliderDown = false, debounce = null, profile = null, selected = 1;

const selection = () => ({ method: Number(element("method").value), percent: Number(element("slider").value) });
const percentLabel = (value) => value === 100 ? "100% · prepared DTM endpoint" : value === 0 ? "0% · original DSM endpoint" : `${value}% · display interpolation`;

function setBusy(state) {
  busy = state.busy; ready = state.ready;
  for (const id of ["method", "slider", "original", "terrain"]) element(id).disabled = busy || !ready;
  element("retry").disabled = busy;
  element("cancel").disabled = !busy;
  const progress = element("progress");
  progress.hidden = !busy;
  if (state.indeterminate) progress.removeAttribute("value");
  else if (Number.isFinite(state.percent)) progress.value = state.percent;
}

function requestSurface() {
  clearTimeout(debounce);
  window.dsm.action("surface", selection());
}

// The native viewers are child windows; report where the page wants them.
function layout() {
  const rects = ["view0", "view1"].map((id) => {
    const r = element(id).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  window.dsm.action("layout", rects);
}
new ResizeObserver(layout).observe(element("view0"));
new ResizeObserver(layout).observe(element("view1"));
window.addEventListener("resize", layout);

function drawChart() {
  const canvas = element("chart");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  g.fillStyle = "white"; g.fillRect(0, 0, width, height);
  if (!profile) return;
  const plot = { left: 64, top: 30, width: width - 88, height: height - 64 };
  const bottom = plot.top + plot.height;
  let low = Infinity, high = -Infinity;
  for (const row of profile) for (const v of row) { low = Math.min(low, v); high = Math.max(high, v); }
  low -= 2; high += 2;
  g.font = '12px "Segoe UI", sans-serif';
  g.fillStyle = "#476174";
  g.fillText("Fixed building transect · original pixel heights (LN02 metres)", 8, 18);
  for (let i = 0; i <= 4; i++) {
    const t = i / 4, y = bottom - t * plot.height;
    g.strokeStyle = "#e2e9ee"; g.lineWidth = 1; g.setLineDash([]);
    g.beginPath(); g.moveTo(plot.left, y); g.lineTo(plot.left + plot.width, y); g.stroke();
    g.textAlign = "right"; g.fillText((low + t * (high - low)).toFixed(0), 56, y + 4);
    g.textAlign = "center"; g.fillText(`${(t * 249.5).toFixed(0)} m`, plot.left + t * plot.width, bottom + 18);
  }
  g.textAlign = "left";
  for (const index of [0, 3, 1, 2]) {
    const row = profile[index];
    g.beginPath();
    row.forEach((v, x) => {
      const px = plot.left + x / (row.length - 1) * plot.width, py = bottom - (v - low) / (high - low) * plot.height;
      if (x === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    g.strokeStyle = COLORS[index]; g.lineWidth = index === selected ? 2.5 : 1.4;
    g.setLineDash(index === 3 ? [6, 4] : []);
    g.stroke();
  }
}
new ResizeObserver(drawChart).observe(element("chart"));

element("slider").addEventListener("input", () => {
  element("percent-label").textContent = percentLabel(Number(element("slider").value));
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (!sliderDown) requestSurface(); }, 200);
});
element("slider").addEventListener("pointerdown", () => { sliderDown = true; });
element("slider").addEventListener("pointerup", () => { sliderDown = false; requestSurface(); });
element("method").onchange = requestSurface;
element("original").onclick = () => { element("slider").value = 0; element("percent-label").textContent = percentLabel(0); requestSurface(); };
element("terrain").onclick = () => { element("slider").value = 100; element("percent-label").textContent = percentLabel(100); requestSurface(); };
element("exaggeration").onchange = () => {
  const input = element("exaggeration");
  if (input.reportValidity()) window.dsm.action("exaggeration", Number(input.value));
};
element("retry").onclick = () => window.dsm.action("retry", selection());
element("cancel").onclick = () => window.dsm.action("cancel");
element("folder").onclick = () => window.dsm.action("folder");
element("controls").onclick = () => window.dsm.action("controls");
for (const button of document.querySelectorAll("[data-camera]")) button.onclick = () => window.dsm.action("camera", button.dataset.camera);
element("profile-toggle").onclick = () => {
  const button = element("profile-toggle");
  button.classList.toggle("on");
  element("chart").classList.toggle("hidden", !button.classList.contains("on"));
  drawChart();
};

window.dsm.onInit(() => { layout(); window.dsm.action("retry", selection()); });
window.dsm.onStatus((state) => { element("status").textContent = state.message; setBusy(state); });
window.dsm.onRestore(({ method, percent }) => {
  element("method").value = String(method);
  element("slider").value = percent;
  element("percent-label").textContent = percentLabel(percent);
});
window.dsm.onCommitted((state) => {
  if (state.profile) profile = state.profile;
  selected = state.method;
  element("heading1").textContent = state.heading;
  element("metrics").textContent = state.metrics;
  element("percent-label").textContent = percentLabel(Number(element("slider").value));
  drawChart();
});
