"use strict";
const element = (id) => document.getElementById(id);
element("reload").onclick = () => {
  if (!element("building-height").reportValidity()) return;
  return window.terrain.action("reload", {
    resolution: Number(element("quality").value),
    buildingHeight: Number(element("building-height").value),
  });
};
element("cancel").onclick = () => window.terrain.action("cancel");
element("reset").onclick = () => window.terrain.action("reset");
element("imagery").onchange = () => window.terrain.action("imagery", element("imagery").checked);
element("height").onchange = () => {
  const input = element("height");
  if (input.reportValidity()) window.terrain.action("height", Number(input.value));
};
function applyBuildingStyle() {
  if (!element("building-opacity").reportValidity()) return;
  window.terrain.action("buildings", {
    visible: element("buildings").checked,
    opacity: Number(element("building-opacity").value) / 100,
    color: element("building-color").value,
  });
}
for (const id of ["buildings", "building-color", "building-opacity"]) {
  element(id).onchange = applyBuildingStyle;
}
window.terrain.onStatus(({ message, busy, buildingsReady }) => {
  for (const id of ["buildings", "building-color", "building-opacity"]) element(id).disabled = !buildingsReady;
  element("status").textContent = message;
  element("reload").disabled = element("quality").disabled = element("building-height").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
});
