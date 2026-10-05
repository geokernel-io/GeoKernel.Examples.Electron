"use strict";
const element = (id) => document.getElementById(id);
function action(name, value) {
  window.cloud.action(name, value).catch((error) => { element("errors").textContent = error.message; });
}
element("reload").addEventListener("click", () => action("reload", Number(element("samples").value)));
element("cancel").addEventListener("click", () => action("cancel"));
element("reset").addEventListener("click", () => action("reset"));
element("colors").addEventListener("change", () => action("style", element("colors").value === "height"));
window.cloud.onStatus((state) => {
  element("status").textContent = state.message;
  element("reload").disabled = element("samples").disabled = state.busy;
  element("cancel").disabled = !state.loading || state.cancelled;
  element("colors").disabled = element("reset").disabled = !state.ready || state.busy;
  element("progress").hidden = !state.busy;
});
window.cloud.onState((state) => {
  element("details").textContent = `Source: ${BigInt(state.total).toLocaleString()} points. ` +
    `Display sample: ${BigInt(state.sample).toLocaleString()} points. ` +
    `Source Z: ${state.minimumZ.toFixed(2)} – ${state.maximumZ.toFixed(2)} m. ` +
    `RGB available: ${state.hasRgb ? "Yes" : "No"}.`;
  element("errors").textContent = state.error.trim();
});
window.cloud.onError((message) => { element("errors").textContent = message; });
