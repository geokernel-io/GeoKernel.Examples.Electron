"use strict";
const element = (id) => document.getElementById(id);
element("reload").onclick = () => window.terrain.action("reload", Number(element("quality").value));
element("cancel").onclick = () => window.terrain.action("cancel");
element("reset").onclick = () => window.terrain.action("reset");
element("imagery").onchange = () => window.terrain.action("imagery", element("imagery").checked);
element("height").onchange = () => {
  const input = element("height");
  if (input.reportValidity()) window.terrain.action("height", Number(input.value));
};
function applyRoadStyle() {
  if (!element("road-opacity").reportValidity()) return;
  window.terrain.action("roads", {
    visible: element("roads").checked,
    opacity: Number(element("road-opacity").value) / 100,
    color: element("road-color").value,
  });
}
for (const id of ["roads", "road-color", "road-opacity"]) {
  element(id).onchange = applyRoadStyle;
}
window.terrain.onStatus(({ message, busy, roadsReady }) => {
  for (const id of ["roads", "road-color", "road-opacity"]) element(id).disabled = !roadsReady;
  element("status").textContent = message;
  element("reload").disabled = element("quality").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
});
