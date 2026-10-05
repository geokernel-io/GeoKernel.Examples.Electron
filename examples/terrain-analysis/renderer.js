"use strict";
const element = (id) => document.getElementById(id);
function action(name, value) {
  return window.terrain.action(name, value).catch((error) => {
    element("status").textContent = error.message;
  });
}
const legends = [
  ["Low", "↓", "↓", "↓", "High"],
  ["0 to <5°", "5 to <15°", "15 to <30°", "30 to <45°", "45 to 90°"],
  ["N — 0°", "NE — 45°", "E — 90°", "SE — 135°", "S — 180°", "SW — 225°", "W — 270°", "NW — 315°", "Flat (slope <0.01°)"],
];
function showLegend() {
  const mode = Number(element("mode").value);
  const legend = element("legend");
  legend.replaceChildren();
  legends[mode].forEach((label, index) => {
    const row = document.createElement("div");
    row.className = "legend-row";
    const swatch = document.createElement("span");
    swatch.className = `swatch mode-${mode}-${index}`;
    const text = document.createElement("span");
    text.textContent = label;
    row.append(swatch, text);
    legend.append(row);
  });
  if (mode !== 1) {
    const note = document.createElement("p");
    note.textContent = mode === 2 ? "Each direction spans ±22.5°." : "Relative ENU relief, with lighting.";
    legend.append(note);
  }
}
element("reload").onclick = () => action("reload", Number(element("quality").value));
element("cancel").onclick = () => action("cancel");
element("reset").onclick = () => action("reset");
element("mode").onchange = () => { showLegend(); action("mode", Number(element("mode").value)); };
element("height").onchange = () => {
  if (element("height").reportValidity()) action("height", Number(element("height").value));
};
window.terrain.onStatus(({ message, busy, loading, ready, cancelled, mesh }) => {
  element("status").textContent = message;
  element("reload").disabled = element("quality").disabled = busy;
  element("cancel").disabled = !loading || cancelled;
  element("progress").hidden = !busy;
  if (ready && !busy) {
    element("info").textContent = `DEM: sagrada_familia_terrain.tif. Heights: Unknown — unverified preview. Mesh: up to ${mesh} samples per side.`;
  }
});
showLegend();
