"use strict";
const element = (id) => document.getElementById(id);
const api = window.profileApi;
const COLORS = ["#66768a", "#087e8b", "#8857bd", "#d98419"];
const LEGENDS = ["Gray DSM · teal classical · purple AI · dashed orange reference · map: A teal, B orange",
  "Teal classical − reference · purple AI − reference · zero is closest"];
const NO_CURSOR = "Move over the chart to locate a sample on both maps.";
// Each sample: [distance, easting, northing, dsm, classical, ai, reference].
let profile = null, errors = false, hovered = -1, state = { busy: true, ready: false, hasProfile: false, drawing: false };

function applyState(next) {
  state = next;
  const ready = !state.busy && state.ready;
  for (const button of document.querySelectorAll(".toolbar button")) button.disabled = !ready;
  for (const id of ["surface", "spacing"]) element(id).disabled = !ready;
  element("export").disabled = state.busy || !state.hasProfile;
  element("retry").disabled = state.busy;
  element("cancel").disabled = !state.busy;
  element("draw").classList.toggle("on", !!state.drawing);
  const progress = element("progress");
  progress.hidden = !state.busy;
  if (Number.isFinite(state.percent)) progress.value = state.percent;
}

// The native maps are child windows; report where the page wants them.
function layout() {
  const rects = ["view0", "view1"].map((id) => {
    const r = element(id).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  api.action("layout", rects);
}
for (const id of ["view0", "view1"]) new ResizeObserver(layout).observe(element(id));
window.addEventListener("resize", layout);

function plotRect(width, height) { return { left: 65, top: 30, width: width - 90, height: height - 72 }; }
const value = (s, band) => s[3 + band] - (errors ? s[6] : 0);

function drawChart() {
  const canvas = element("chart");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  g.fillStyle = "white"; g.fillRect(0, 0, width, height);
  g.font = '12px "Segoe UI", sans-serif';
  g.fillStyle = "#476174";
  if (!profile) {
    g.textAlign = "center";
    g.fillText("Draw a transect: choose A, then B on either map.", width / 2, height / 2);
    return;
  }
  const bands = errors ? [1, 2] : [0, 1, 2, 3];
  let low = errors ? 0 : Infinity, high = errors ? 0 : -Infinity;
  for (const s of profile.samples) for (const band of bands) { low = Math.min(low, value(s, band)); high = Math.max(high, value(s, band)); }
  const pad = Math.max(0.25, (high - low) * 0.12);
  low -= pad; high += pad;
  const plot = plotRect(width, height), bottom = plot.top + plot.height;
  const Y = (v) => bottom - (v - low) / (high - low) * plot.height;
  const X = (s) => plot.left + s[0] / profile.length * plot.width;
  g.textAlign = "left";
  g.fillText(errors ? "Estimate minus reference (m) · zero is closest" : "Source elevation (LN02 metres) · all four rasters on one scale", 8, 18);
  for (let i = 0; i <= 4; i++) {
    const t = i / 4, y = bottom - t * plot.height;
    g.strokeStyle = "#e2e9ee"; g.lineWidth = 1; g.setLineDash([]);
    g.beginPath(); g.moveTo(plot.left, y); g.lineTo(plot.left + plot.width, y); g.stroke();
    g.textAlign = "right"; g.fillText((low + t * (high - low)).toFixed(1), 58, y + 4);
    g.textAlign = "center"; g.fillText((t * profile.length).toFixed(1), plot.left + t * plot.width, bottom + 18);
  }
  g.fillText("Distance along A → B (projected metres)", width / 2, height - 8);
  if (errors) {
    g.strokeStyle = "#b4bfca"; g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(plot.left, Y(0)); g.lineTo(plot.left + plot.width, Y(0)); g.stroke();
  }
  for (const band of [0, 3, 1, 2]) {
    if (!bands.includes(band)) continue;
    g.beginPath();
    profile.samples.forEach((s, i) => { if (i === 0) g.moveTo(X(s), Y(value(s, band))); else g.lineTo(X(s), Y(value(s, band))); });
    g.strokeStyle = COLORS[band]; g.lineWidth = band === 0 ? 1.5 : 2;
    g.setLineDash(band === 3 ? [6, 4] : []);
    g.stroke();
  }
  if (hovered >= 0 && hovered < profile.samples.length) {
    const x = X(profile.samples[hovered]);
    g.strokeStyle = "#dd3470"; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, plot.top); g.lineTo(x, bottom); g.stroke();
  }
}
new ResizeObserver(drawChart).observe(element("chart"));

function setHovered(index) {
  if (index === hovered) return;
  hovered = index;
  const s = profile && index >= 0 ? profile.samples[index] : null;
  element("cursor").textContent = s
    ? `Distance: ${s[0].toFixed(1)} m\nE ${s[1].toFixed(2)} · N ${s[2].toFixed(2)}\n\nDSM: ${s[3].toFixed(2)} m\nClassical: ${s[4].toFixed(2)} m\nAI: ${s[5].toFixed(2)} m\nReference: ${s[6].toFixed(2)} m`
    : NO_CURSOR;
  api.action("hover", index);
  drawChart();
}

element("chart").addEventListener("mousemove", (event) => {
  const canvas = element("chart"), plot = plotRect(canvas.clientWidth, canvas.clientHeight);
  const x = event.offsetX, y = event.offsetY, count = profile ? profile.samples.length : 0;
  const inside = count && x >= plot.left && x <= plot.left + plot.width && y >= plot.top && y <= plot.top + plot.height;
  setHovered(inside ? Math.min(Math.max(Math.round((x - plot.left) / plot.width * (count - 1)), 0), count - 1) : -1);
});
element("chart").addEventListener("mouseleave", () => setHovered(-1));

element("draw").onclick = () => api.action("draw", !state.drawing);
element("example").onclick = () => api.action("example");
element("clear").onclick = () => api.action("clear");
for (const button of document.querySelectorAll("[data-tool]")) button.onclick = () => api.action("tool", button.dataset.tool);
for (const button of document.querySelectorAll("[data-zoom]")) button.onclick = () => api.action("zoom", button.dataset.zoom);
element("surface").onchange = () => api.action("surface", Number(element("surface").value));
element("spacing").onchange = () => {
  const input = element("spacing");
  if (input.reportValidity()) api.action("spacing", Number(input.value));
};
element("mode").onchange = () => {
  errors = element("mode").value === "1";
  element("legend").textContent = LEGENDS[errors ? 1 : 0];
  drawChart();
};
element("export").onclick = () => api.action("export");
element("retry").onclick = () => api.action("retry");
element("cancel").onclick = () => api.action("cancel");

api.onInit(() => { layout(); api.action("retry"); });
api.onStatus((next) => { element("status").textContent = next.message; applyState(next); });
api.onInstructions((text) => { element("instructions").textContent = text; });
api.onHeading((text) => { element("heading1").textContent = text; });
api.onProfile((next) => {
  profile = next;
  hovered = -1;
  element("cursor").textContent = NO_CURSOR;
  element("stats").textContent = !profile ? "No transect selected." :
    `THIS TRANSECT ONLY\n\nLength: ${profile.length.toFixed(1)} m · ${profile.samples.length} samples\nActual spacing: ${profile.spacing.toFixed(3)} m\n\n` +
    `Classical RMSE: ${profile.rmse[0].toFixed(2)} m\nClassical MAE: ${profile.mae[0].toFixed(2)} m\n\nAI RMSE: ${profile.rmse[1].toFixed(2)} m\nAI MAE: ${profile.mae[1].toFixed(2)} m\n\n` +
    "Lower error is better. These are line-sample errors, not full-area accuracy.";
  drawChart();
});
