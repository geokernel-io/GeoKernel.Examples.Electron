"use strict";
const element = (id) => document.getElementById(id);
let snapshot = null, available = false;
function selectionButtons() {
  const enabled = available && snapshot?.entries.length > 0;
  for (const id of ["selected", "focus", "clear"]) element(id).disabled = !enabled;
}
for (const id of ["reload", "cancel", "reset", "focus", "clear"]) {
  element(id).onclick = () => window.picking.action(id);
}
for (const id of ["imagery", "buildings", "roads", "multiple"]) {
  element(id).onchange = () => window.picking.action(id, element(id).checked);
}
element("height").onchange = () => {
  if (element("height").reportValidity()) window.picking.action("height", Number(element("height").value));
};
element("selected").onchange = () => {
  if (snapshot) window.picking.action("activate", { revision: snapshot.revision, index: element("selected").value });
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && available) window.picking.action("clear");
});
window.picking.onStatus(({ message, busy, ready }) => {
  available = ready && !busy;
  element("status").textContent = message;
  element("reload").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
  for (const id of ["imagery", "buildings", "roads", "multiple", "height", "reset"]) element(id).disabled = !available;
  selectionButtons();
});
window.picking.onSelection((value) => {
  snapshot = value;
  const entries = value.entries;
  const active = entries.find((entry) => entry.index === value.activeIndex) || entries[0];
  element("selected").replaceChildren();
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.index;
    option.textContent = `${entry.layer} / ${entry.attributes.name || entry.sourceId || entry.featureId}`;
    option.selected = entry === active;
    element("selected").append(option);
  }
  element("count").textContent = entries.length ? `${entries.length} selected` : "No selection";
  const rows = [];
  if (active) {
    rows.push(["Layer", active.layer], ["Type", active.type], ["Scene feature ID", active.featureId]);
    if (active.sourceFid !== undefined) rows.push(["Source FID", active.sourceFid]);
    if (active.displayHeight !== undefined) rows.push(["Display height (estimated)", `${active.displayHeight} m`]);
    rows.push(...Object.entries(active.attributes).sort(([a], [b]) => a.localeCompare(b)));
  }
  element("attributes").replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const td = document.createElement("td");
      td.textContent = value === null ? "(null)" : String(value);
      tr.append(td);
    }
    element("attributes").append(tr);
  }
  selectionButtons();
});
