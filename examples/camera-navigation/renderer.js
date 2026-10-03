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
window.terrain.onStatus(({ message, busy, ready }) => {
  element("navigation").disabled = busy || !ready;
  element("status").textContent = message;
  element("reload").disabled = element("quality").disabled = busy;
  element("cancel").disabled = !busy;
  element("progress").hidden = !busy;
});

const cameraAction = (name, value) => window.terrain.action("camera:" + name, value);
element("go").onclick = () => cameraAction("preset", element("preset").selectedIndex);
element("smooth").onchange = () => cameraAction("smooth", element("smooth").checked);
element("stop").onclick = () => cameraAction("stop");
element("zoom-in").onclick = () => cameraAction("zoom", "in");
element("zoom-out").onclick = () => cameraAction("zoom", "out");
element("north").onclick = () => cameraAction("north");
element("save").onclick = () => cameraAction("save", element("name").value);
element("restore").onclick = () => cameraAction("restore", element("views").selectedIndex);
element("delete").onclick = () => cameraAction("delete", element("views").selectedIndex);
let previousNames = "";
window.terrain.onCamera(({ camera, names }) => {
  element("camera-status").textContent = `Heading: ${((camera[0] % 360 + 360) % 360).toFixed(1)} degrees | Tilt: ${camera[1].toFixed(1)} degrees`;
  const key = JSON.stringify(names);
  if (key !== previousNames) {
    const select = element("views"); const selected = select.selectedIndex;
    select.replaceChildren(...names.map(name => { const option = document.createElement("option"); option.textContent = name; return option; }));
    select.selectedIndex = names.length ? Math.max(0, Math.min(selected, names.length - 1)) : -1;
    previousNames = key;
  }
  element("restore").disabled = element("delete").disabled = names.length === 0;
  element("save").disabled = names.length >= 20;
});

