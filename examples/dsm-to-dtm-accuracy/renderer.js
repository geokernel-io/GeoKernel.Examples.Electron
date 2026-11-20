"use strict";
const element = (id) => document.getElementById(id);
const api = window.accuracyApi;
const METHOD_COLORS = ["#087e8b", "#8857bd"];
const BIN_LABELS = ["≤0.25", "0.25–0.5", "0.5–1", "1–2", "2–5", ">5 m"];
const LEGEND_TITLES = ["Estimated DTM − reference: blue below · white zero · red above (metres)",
  "Absolute reference error: white zero · orange/red larger errors (metres)"];
let display = { mode: 0, limit: 2, stops: [] }, metrics = null, state = { busy: true, ready: false, selecting: false };

function applyState(next) {
  state = next;
  const ready = !state.busy && state.ready;
  for (const button of document.querySelectorAll(".toolbar button")) button.disabled = !ready;
  for (const id of ["mode", "threshold", "preset", "export"]) element(id).disabled = !ready;
  element("range").disabled = !ready || element("mode").value === "2";
  element("retry").disabled = state.busy;
  element("cancel").disabled = !state.busy;
  element("select").classList.toggle("on", !!state.selecting);
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

function canvasContext(id) {
  const canvas = element(id), ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.fillStyle = "white";
  g.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  g.font = '12px "Segoe UI", sans-serif';
  g.fillStyle = "#476174";
  return [g, canvas.clientWidth, canvas.clientHeight];
}

function drawLegend() {
  const [g, w, h] = canvasContext("legend");
  g.textAlign = "center";
  if (display.mode === 2) {
    g.fillText("Neutral relief: same light and contrast for both terrain estimates. Switch to an error view to compare reference differences.", w / 2, h / 2 + 4);
    return;
  }
  g.fillText(LEGEND_TITLES[display.mode], w / 2, 16);
  const gradient = g.createLinearGradient(70, 0, w - 70, 0);
  display.stops.forEach((c, i) => gradient.addColorStop(i / 20, `rgb(${c[0]},${c[1]},${c[2]})`));
  g.fillStyle = gradient;
  g.fillRect(70, 25, Math.max(1, w - 140), 13);
  g.fillStyle = "#476174";
  g.fillText("One shared scale · display saturation only; numeric errors are unchanged", w / 2, 56);
  g.textAlign = "left";
  g.fillText(display.mode === 0 ? `≤ −${display.limit} m` : "0 m", 8, 56);
  g.textAlign = "right";
  g.fillText(`≥ ${display.limit} m`, w - 8, 56);
}

function drawHistogram() {
  const [g, w, h] = canvasContext("histogram");
  if (!metrics) return;
  g.textAlign = "center";
  g.fillText("Absolute error distribution · evaluated area · teal classical / purple AI", w / 2, 16);
  const plot = { left: 50, top: 30, width: w - 70, height: h - 60 }, bottom = plot.top + plot.height, group = plot.width / 6;
  let maximum = 10;
  for (const m of metrics) for (const count of m.bins) maximum = Math.max(maximum, (100 * count) / m.count);
  maximum = Math.ceil(maximum / 10) * 10;
  for (let tick = 0; tick <= 2; tick++) {
    const y = bottom - tick * 0.5 * plot.height;
    g.strokeStyle = "#e2e9ee";
    g.beginPath(); g.moveTo(plot.left, y); g.lineTo(plot.left + plot.width, y); g.stroke();
    g.textAlign = "right";
    g.fillText(`${(tick * 0.5 * maximum).toFixed(0)}%`, 43, y + 4);
  }
  for (let b = 0; b < 6; b++) {
    metrics.forEach((m, method) => {
      const height = ((100 * m.bins[b]) / m.count / maximum) * plot.height;
      g.fillStyle = METHOD_COLORS[method];
      g.fillRect(plot.left + b * group + group * (0.18 + method * 0.32), bottom - height, group * 0.28, height);
    });
    g.fillStyle = "#476174";
    g.textAlign = "center";
    g.fillText(BIN_LABELS[b], plot.left + b * group + group / 2, bottom + 16);
  }
}
new ResizeObserver(() => { drawLegend(); drawHistogram(); }).observe(element("legend"));

function showMetrics({ metrics: values, threshold, areaName }) {
  metrics = values;
  element("above-header").textContent = `|error| > ${threshold} m (%)`;
  document.querySelectorAll("#metrics tbody tr").forEach((row, method) => {
    const m = values[method];
    [m.rmse, m.mae, m.bias, m.p95].forEach((v, i) => { row.cells[i + 1].textContent = v.toFixed(3); });
    row.cells[5].textContent = ((100 * m.above) / m.count).toFixed(2);
  });
  const rank = (c, a) => (Math.abs(c - a) <= 1e-9 ? "Tie" : c < a ? "Classical" : "AI · pix_grad");
  element("winners").textContent = `THIS AREA ONLY\n\nLower RMSE: ${rank(values[0].rmse, values[1].rmse)}\nLower MAE: ${rank(values[0].mae, values[1].mae)}\n\n` +
    "Different metrics can rank methods differently. No overall winner is implied.";
  element("scope").textContent = `${areaName} · ${values[0].count} common valid reference pixels · evaluated cell footprint ${(values[0].count * 0.25).toFixed(2)} m² · reference coverage 100% · bias is estimate − reference`;
  drawHistogram();
}

element("select").onclick = () => api.action("select");
element("current").onclick = () => api.action("current");
element("full-sample").onclick = () => api.action("preset", 0);
for (const button of document.querySelectorAll("[data-tool]")) button.onclick = () => api.action("tool", button.dataset.tool);
for (const button of document.querySelectorAll("[data-zoom]")) button.onclick = () => api.action("zoom", button.dataset.zoom);
element("mode").onchange = () => { element("range").disabled = element("mode").value === "2"; api.action("mode", Number(element("mode").value)); };
element("range").onchange = () => api.action("range", Number(element("range").value));
element("threshold").onchange = () => { const input = element("threshold"); if (input.reportValidity()) api.action("threshold", Number(input.value)); };
element("preset").onchange = () => api.action("preset", Number(element("preset").value));
element("export").onclick = () => api.action("export");
element("retry").onclick = () => api.action("retry");
element("cancel").onclick = () => api.action("cancel");

api.onInit(() => { layout(); api.action("retry"); });
api.onStatus((next) => { element("status").textContent = next.message; applyState(next); });
api.onInstructions((text) => { element("instructions").textContent = text; });
api.onDisplay((next) => {
  display = next;
  if (next.headings) { element("heading1").textContent = next.headings[0]; element("heading2").textContent = next.headings[1]; }
  drawLegend();
});
api.onMetrics(showMetrics);
api.onPreset((index) => { element("preset").value = String(index); });
api.onProbe((text) => { element("probe").textContent = text; });
