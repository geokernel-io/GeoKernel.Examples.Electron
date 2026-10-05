"use strict";
const element = (id) => document.getElementById(id);
let available = false, state = null, actionError = "";
function controls() {
  element("stop").disabled = !available || !state?.active;
  element("focus").disabled = !available || !state?.attached || !element("visible").checked;
  element("errors").textContent = [actionError, state?.error?.trim()].filter(Boolean).join("\n");
}
for (const action of ["reload", "cancel", "stop", "focus", "reset"]) {
  element(action).onclick = () => window.tiles.action(action);
}
element("start").onclick = () => {
  if (element("budget").reportValidity()) window.tiles.action("start", Number(element("budget").value));
};
for (const action of ["imagery", "visible"]) {
  element(action).onchange = () => window.tiles.action(action, element(action).checked);
}
window.tiles.onStatus(({ message, busy, ready, visible }) => {
  available = ready && !busy;
  element("status").textContent = message;
  element("visible").checked = visible;
  element("reload").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
  for (const id of ["imagery", "visible", "budget", "start", "reset"]) element(id).disabled = !available;
  controls();
});
window.tiles.onError((error) => { actionError = error; controls(); });
window.tiles.onState((value) => {
  state = value;
  const phase = !value.active ? "Stopped" : value.loading ? "Updating (previous tiles visible)" : "Active";
  element("details").textContent = [
    `State: ${phase}`, `Loaded tiles: ${value.tiles}`, `Deferred tiles: ${value.deferredTiles}`,
    `Detail budget limited: ${value.selectionLimited ? "Yes" : "No"}`,
    `CPU cache: ${(Number(value.cacheBytes) / (1024 * 1024)).toFixed(1)} MiB`,
    `Cache hits: ${value.cacheHits}`, `Drawn vertices: ${value.drawnVertices}`,
    `GPU upload pending: ${value.uploadPending ? "Yes" : "No"}`,
  ].join("\n");
  controls();
});
