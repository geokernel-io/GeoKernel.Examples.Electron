"use strict";
const element = (id) => document.getElementById(id);
let available = false, snapshot = null;
const settings = ["eye", "target", "radius", "spacing", "width"];

function buttons() {
  element("calculate").disabled = !available || !snapshot?.hasObserver || snapshot?.running;
  element("pause").disabled = !available || !snapshot?.running;
  element("clear").disabled = !available || !snapshot?.hasObserver;
}
for (const action of ["reload", "cancel", "calculate", "pause", "clear", "reset"]) {
  element(action).onclick = () => window.viewshed.action(action);
}
for (const action of ["imagery", "capture", "overlay"]) {
  element(action).onchange = () => window.viewshed.action(action, element(action).checked);
}
for (const id of settings) {
  element(id).onchange = () => {
    if (settings.every(key => element(key).reportValidity())) {
      window.viewshed.action("settings", Object.fromEntries(settings.map(key => [key, Number(element(key).value)])));
    }
  };
}
element("height").onchange = () => {
  if (element("height").reportValidity()) window.viewshed.action("height", Number(element("height").value));
};
window.viewshed.onStatus(({ message, busy, ready }) => {
  available = ready && !busy;
  element("status").textContent = message;
  element("reload").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
  for (const id of [...settings, "imagery", "capture", "overlay", "height", "reset"]) element(id).disabled = !available;
  buttons();
});
window.viewshed.onResult((value) => {
  snapshot = value;
  element("capture").checked = value.capture;
  element("location").textContent = value.hasObserver
    ? `Observer: ${value.longitude.toFixed(6)}° E, ${value.latitude.toFixed(6)}° N` : "No observer selected.";
  const count = state => value.cells.filter(cell => cell === state).length;
  element("result").textContent = [value.message,
    `Visible: ${count(2)} | Blocked: ${count(3)}`, `Unknown: ${count(4)} | Pending: ${count(1)}`,
    `Grid spacing: ${value.cellSpacing.toFixed(1)} m`,
    `Maximum ray spacing: ${value.maxRaySpacing.toFixed(1)} m`, value.overlayMessage].join("\n");
  element("analysis-progress").value = value.cells.length ? 100 * value.processed / value.cells.length : 0;
  element("calculate").textContent = value.complete ? "Recalculate" : value.cells.length ? "Resume calculation" : "Calculate";
  buttons();
  drawMap();
});

function drawMap() {
  const canvas = element("map");
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
  if (!snapshot?.width) {
    ctx.fillText("Select an observer on terrain.", 12, 100);
    ctx.fillText("Then calculate visibility.", 12, 120);
    return;
  }
  const side = Math.max(1, Math.min(width - 40, height - 55));
  const left = (width - side) / 2, top = 25, cell = side / snapshot.width;
  const colors = [null, "#dce3eb", "#239b56", "#d35445", "#858585"];
  snapshot.cells.forEach((state, i) => {
    if (!colors[state]) return;
    ctx.fillStyle = colors[state];
    ctx.fillRect(left + i % snapshot.width * cell, top + Math.floor(i / snapshot.width) * cell, cell, cell);
  });
  ctx.fillStyle = "black";
  ctx.fillText("N ↑", width / 2 - 12, 18);
  ctx.fillText("W", 2, top + side / 2);
  ctx.fillText("E", width - 14, top + side / 2);
  ctx.fillText(`S ↓   Radius: ${snapshot.radius.toFixed(0)} m`, left, top + side + 20);
  const x = left + side / 2, y = top + side / 2;
  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y);
  ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
}
new ResizeObserver(drawMap).observe(element("map"));
