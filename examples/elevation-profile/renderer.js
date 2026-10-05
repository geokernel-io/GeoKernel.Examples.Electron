"use strict";
const element = (id) => document.getElementById(id);
let available = false, snapshot = null;

function buttons() {
  const count = snapshot?.pointCount || 0;
  element("undo").disabled = element("clear").disabled = !available || count === 0;
  element("finish").disabled = !available || !snapshot?.capture || count < 2;
}
for (const action of ["reload", "cancel", "finish", "undo", "clear", "reset"]) {
  element(action).onclick = () => window.profile.action(action);
}
for (const action of ["imagery", "capture"]) {
  element(action).onchange = () => window.profile.action(action, element(action).checked);
}
for (const action of ["spacing", "height"]) {
  element(action).onchange = () => {
    if (element(action).reportValidity()) window.profile.action(action, Number(element(action).value));
  };
}
document.addEventListener("keydown", (event) => {
  if (!available || event.target.matches("input, select, textarea")) return;
  if (event.key === "Escape" || event.key === "Backspace") {
    event.preventDefault();
    window.profile.action(event.key === "Escape" ? "clear" : "undo");
  }
});
window.profile.onStatus(({ message, busy, ready }) => {
  available = ready && !busy;
  element("status").textContent = message;
  element("reload").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
  for (const id of ["imagery", "spacing", "capture", "height", "reset"]) element(id).disabled = !available;
  buttons();
});
window.profile.onResult((value) => {
  snapshot = value;
  element("capture").checked = value.capture;
  const lines = [`${value.pointCount} route points`,
    `Samples: ${value.processed}/${value.samples.length}`,
    `Horizontal: ${value.horizontal.toFixed(1)} m`,
    `Ascent: ${value.ascent.toFixed(1)} m`,
    `Descent: ${value.descent.toFixed(1)} m`,
    `Maximum interval: ${value.maxInterval.toFixed(1)} m`,
    `NoData: ${value.missing}`];
  if (value.message) lines.push(value.message);
  element("result").textContent = lines.join("\n");
  buttons();
  drawChart();
});

function drawChart() {
  const canvas = element("chart");
  const { width, height } = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "black";
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.fillText("Elevation (m; vertical datum unverified)", 8, 20);
  const samples = snapshot?.samples.slice(0, snapshot.processed) || [];
  const heights = samples.filter(s => s.height !== null).map(s => s.height);
  if (!heights.length || snapshot.horizontal <= 0) {
    ctx.fillText((snapshot?.pointCount || 0) < 2 ? "Click two or more terrain points." :
      "No elevation samples available yet.", 60, 80);
    return;
  }
  let low = Math.min(...heights), high = Math.max(...heights);
  const padding = Math.max(.5, (high - low) * .1);
  low -= padding;
  high += padding;
  const left = 65, top = 30, w = Math.max(1, width - 95), h = Math.max(1, height - 80);
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = left + w * i / 4, y = top + h - h * i / 4;
    ctx.strokeStyle = "gainsboro";
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + w, y); ctx.stroke();
    ctx.fillText((low + (high - low) * i / 4).toFixed(1), 3, y + 4);
    ctx.fillText((snapshot.horizontal * i / 4).toFixed(0), x - 15, top + h + 18);
  }
  ctx.fillText("Horizontal distance (m)", left, height - 8);
  ctx.strokeStyle = ctx.fillStyle = "steelblue";
  ctx.lineWidth = 2;
  let previous = null;
  for (const sample of samples) {
    if (sample.height === null) { previous = null; continue; }
    const x = left + sample.distance / snapshot.horizontal * w;
    const y = top + h - (sample.height - low) / (high - low) * h;
    if (previous) {
      ctx.beginPath(); ctx.moveTo(...previous); ctx.lineTo(x, y); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
    previous = [x, y];
  }
}
new ResizeObserver(drawChart).observe(element("chart"));
