"use strict";
const controls = document.querySelectorAll("input, button");
const status = document.getElementById("status");
const scale = document.getElementById("scale");
const height = document.getElementById("height");

for (const control of controls) {
  if (control.type === "number") continue;
  control.addEventListener(control.type === "checkbox" ? "change" : "click", async () => {
    if (control.id === "apply" && (!scale.reportValidity() || !height.reportValidity())) return;
    const value = control.id === "apply" ? { scale: scale.valueAsNumber, height: height.valueAsNumber } : control.checked;
    try { await window.globe.change(control.id, value); }
    catch (error) { status.textContent = error.message; }
  });
}

window.globe.onState((state) => {
  for (const control of controls) {
    control.disabled = state.busy ||
      (["rotate", "scale", "height", "apply", "remove"].includes(control.id) && !state.present) ||
      (control.id === "restore" && state.present);
    if (control.type === "checkbox") control.checked = state[control.id];
  }
  scale.value = state.placement.scale;
  height.value = state.placement.height;
  status.textContent = state.message;
  status.title = state.message;
});
