"use strict";
const element = (id) => document.getElementById(id);
let available = false, snapshot = null;

function buttons() {
  const count = snapshot?.points.length || 0;
  const minimum = snapshot?.areaMode ? 3 : 2;
  element("undo").disabled = element("clear").disabled = !available || count === 0;
  element("finish").disabled = !available || !snapshot?.capture || count < minimum ||
    (snapshot.areaMode && !snapshot.validArea);
}
for (const action of ["reload", "cancel", "finish", "undo", "clear", "reset"]) {
  element(action).onclick = () => window.measurement.action(action);
}
for (const action of ["imagery", "capture"]) {
  element(action).onchange = () => window.measurement.action(action, element(action).checked);
}
element("mode").onchange = () => window.measurement.action("area", element("mode").value === "area");
element("height").onchange = () => {
  if (element("height").reportValidity()) window.measurement.action("height", Number(element("height").value));
};
document.addEventListener("keydown", (event) => {
  if (!available || event.target.matches("input, select, textarea")) return;
  if (event.key === "Escape" || event.key === "Backspace") {
    event.preventDefault();
    window.measurement.action(event.key === "Escape" ? "clear" : "undo");
  }
});
window.measurement.onStatus(({ message, busy, ready }) => {
  available = ready && !busy;
  element("status").textContent = message;
  element("reload").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
  for (const id of ["imagery", "mode", "capture", "height", "reset"]) element(id).disabled = !available;
  buttons();
});
window.measurement.onResult((value) => {
  snapshot = value;
  element("capture").checked = value.capture;
  element("mode").value = value.areaMode ? "area" : "distance";
  const minimum = value.areaMode ? 3 : 2;
  const lines = [`${value.points.length} points`];
  if (value.points.length < minimum) lines.push(`Add at least ${minimum} points.`);
  if (value.validArea) lines.push(`Plan area: ${value.planArea.toFixed(2)} m²`);
  lines.push(`Horizontal ${value.areaMode ? "perimeter" : "length"}: ${value.horizontal.toFixed(2)} m`,
    `3D segment total: ${value.length3D.toFixed(2)} m`);
  if (!value.areaMode && value.points.length >= 2) lines.push(`End-to-start ΔUp: ${value.deltaUp.toFixed(2)} m`);
  if (value.message) lines.push(value.message);
  element("result").textContent = lines.join("\n");
  element("points").replaceChildren();
  for (const point of value.points) {
    const tr = document.createElement("tr");
    for (const key of ["east", "north", "up"]) {
      const td = document.createElement("td");
      td.textContent = point[key].toFixed(2);
      tr.append(td);
    }
    element("points").append(tr);
  }
  buttons();
});
