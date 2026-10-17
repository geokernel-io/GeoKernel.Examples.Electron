"use strict";
const controls = document.querySelectorAll("input, select, button");
const status = document.getElementById("status");
let fieldKey = "";

for (const control of controls) {
  control.addEventListener(control.id === "zoom" ? "click" : "change", async () => {
    const value = control.type === "checkbox" ? control.checked :
      control.id === "opacity" ? Number(control.value) / 100 : control.value;
    try { await window.globe.change(control.id, value); }
    catch (error) { status.textContent = error.message; }
  });
}

window.globe.onState((state) => {
  const key = JSON.stringify(state.fields);
  if (key !== fieldKey) {
    fieldKey = key;
    for (const id of ["categoryField", "labelField"]) {
      const select = document.getElementById(id);
      select.replaceChildren();
      if (id === "categoryField") select.add(new Option("Uniform", ""));
      for (const field of state.fields) select.add(new Option(field, field));
    }
  }
  for (const control of controls) {
    control.disabled = !state.loaded || state.busy;
    if (control.id === "zoom") continue;
    const value = control.id === "esri" ? state.esri :
      control.id === "opacity" ? state.opacity * 100 : state.style[control.id];
    if (control.type === "checkbox") control.checked = value;
    else control.value = value;
  }
  status.textContent = state.message;
  status.title = state.message;
});
