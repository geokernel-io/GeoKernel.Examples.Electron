"use strict";
const controls = document.querySelectorAll("input, button");
const status = document.getElementById("status");

for (const control of controls) {
  control.addEventListener(control.id === "zoom" ? "click" : "change", async () => {
    if (control.type === "number" && !control.reportValidity()) return;
    const value = control.type === "checkbox" ? control.checked : Number(control.value);
    try { await window.globe.change(control.id, value); }
    catch (error) { status.textContent = error.message; }
  });
}

window.globe.onState((state) => {
  for (const control of controls) {
    control.disabled = !state.loaded || state.busy ||
      (control.id === "displayHeight" && state.extruded);
    if (control.type === "checkbox")
      control.checked = control.id === "extrude" ? state.extruded : state[control.id];
    if (control.id === "displayHeight") control.value = state.displayHeight;
  }
  status.textContent = state.message;
  status.title = state.message;
});
