"use strict";

const controls = document.querySelectorAll("input");
const status = document.getElementById("status");

for (const control of controls) {
  control.addEventListener("change", async () => {
    try {
      await window.globe.toggle(control.id, control.checked);
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

window.globe.onState(({ options, message }) => {
  for (const control of controls) {
    control.disabled = false;
    control.checked = control.id === "basemap" ? options.basemap >= 0 : options[control.id];
  }
  status.textContent = message;
  status.title = message;
});
