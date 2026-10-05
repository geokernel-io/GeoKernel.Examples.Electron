"use strict";
const element = (id) => document.getElementById(id);
const placementFields = ["longitude", "latitude", "offset", "heading", "pitch", "roll", "scale"];
element("reload").onclick = () => {
  if (!placementFields.every(id => element(id).reportValidity())) return;
  return window.terrain.action("reload", {
    resolution: Number(element("quality").value),
    placement: placementFields.map(id => Number(element(id).value)),
  });
};
element("cancel").onclick = () => window.terrain.action("cancel");
element("reset").onclick = () => window.terrain.action("reset");
element("focus").onclick = () => window.terrain.action("focus");
element("visible").onchange = () => window.terrain.action("visible", element("visible").checked);
element("imagery").onchange = () => window.terrain.action("imagery", element("imagery").checked);
element("height").onchange = () => {
  if (element("height").reportValidity()) window.terrain.action("height", Number(element("height").value));
};
window.terrain.onStatus(({ message, busy, modelReady }) => {
  element("visible").disabled = element("focus").disabled = !modelReady;
  element("status").textContent = message;
  for (const id of ["reload", "quality", ...placementFields]) element(id).disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
});
