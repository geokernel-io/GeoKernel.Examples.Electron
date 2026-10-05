"use strict";
const $ = (id) => document.getElementById(id);
let layers = [], activeId = "", pending = null, debounce = null;
let chain = Promise.resolve();

function enqueue(work) {
  chain = chain.then(work).catch((error) => { $("status").textContent = error.message; });
  return chain;
}
function current() { return layers.find((item) => item.id === activeId); }
function options(id, entries, value) {
  $(id).replaceChildren(...entries.map(([text, key]) => new Option(text, key)));
  $(id).value = value;
}
function counts() {
  const item = current();
  if (!item) return;
  $("counts").textContent = `Matching records: ${item.matchingRecords} / ${item.records}\nDrawable matching ranges: ${item.drawableRanges}`;
  $("focus").disabled = !(item.drawableRanges > 0 && item.visible && item.opacity > 0);
}
function values() {
  options("values", [["Choose a value or type text", ""],
    ...(current()?.attributes[$("field").value] || []).map((value) => [value, value])], "");
  $("values").disabled = $("values").options.length <= 1;
}
function sync() {
  const item = current() || layers[0];
  activeId = item?.id || "";
  options("layer", layers.map((entry) => [entry.name, entry.id]), activeId);
  if (!item) return;
  $("visible").checked = item.visible;
  $("opacity").value = Math.round(item.opacity * 100);
  $("color").value = item.color || "#ffffff";
  const fields = Object.keys(item.attributes).sort((a, b) => a.localeCompare(b));
  options("theme", [["Uniform / source color", ""], ...fields.map((key) => [key, key])], item.theme);
  options("field", [["All attributes / source IDs", ""], ...fields.map((key) => [key, key])], item.field);
  $("text").value = item.text;
  values();
  counts();
}
async function style(command) {
  const result = await window.styling.action("style", command);
  if (result) { layers = result; counts(); }
}
function flush() {
  clearTimeout(debounce);
  debounce = null;
  const command = pending;
  pending = null;
  return command ? style(command) : Promise.resolve();
}
function queueFilter() {
  pending = { action: "filter", id: activeId, field: $("field").value, text: $("text").value };
  clearTimeout(debounce);
  debounce = setTimeout(() => enqueue(flush), 250);
}
function command(action, values = {}) {
  return { action, id: activeId, ...values };
}
$("text").addEventListener("input", queueFilter);
$("layer").addEventListener("change", () => {
  const id = $("layer").value;
  enqueue(async () => { await flush(); activeId = id; sync(); });
});
for (const id of ["visible", "opacity"]) $(id).addEventListener("change", () => {
  const value = command("appearance", { visible: $("visible").checked, opacity: Number($("opacity").value) / 100 });
  enqueue(() => style(value));
});
for (const id of ["color", "theme"]) $(id).addEventListener("change", () => {
  const value = command(id, id === "color" ? { color: $("color").value } : { field: $("theme").value });
  enqueue(async () => { await flush(); await style(value); sync(); });
});
$("field").addEventListener("change", () => { values(); queueFilter(); enqueue(flush); });
$("values").addEventListener("change", () => {
  if ($("values").selectedIndex > 0) { $("text").value = $("values").value; queueFilter(); }
});
$("clear").addEventListener("click", () => { $("text").value = ""; queueFilter(); enqueue(flush); });
$("source").addEventListener("click", () => {
  const value = command("color", { color: "" });
  enqueue(async () => { await flush(); await style(value); sync(); });
});
$("focus").addEventListener("click", () => {
  const value = command("focus");
  enqueue(async () => { await flush(); await style(value); });
});
$("reset").addEventListener("click", () => enqueue(async () => {
  clearTimeout(debounce);
  pending = null;
  await style({ action: "reset" });
  sync();
}));
$("reload").addEventListener("click", () => enqueue(async () => {
  await flush();
  await window.styling.action("reload");
}));
// Cancellation must bypass the queue while an asynchronous download is pending.
$("cancel").addEventListener("click", () =>
  window.styling.action("cancel").catch((error) => { $("status").textContent = error.message; }));
$("imagery").addEventListener("change", () => {
  const value = $("imagery").checked;
  enqueue(() => window.styling.action("imagery", value));
});
$("height").addEventListener("change", () => {
  const value = Number($("height").value);
  enqueue(() => window.styling.action("height", value));
});
$("camera").addEventListener("click", () => enqueue(() => window.styling.action("camera")));
window.styling.onLoaded((result) => {
  clearTimeout(debounce);
  pending = null;
  layers = result;
  sync();
});
window.styling.onStatus(({ message, busy, ready, projectPath }) => {
  $("status").textContent = message;
  $("reload").disabled = busy;
  $("open").disabled = busy;
  $("save").disabled = $("save-as").disabled = busy || !ready;
  $("project-path").textContent = projectPath || "Unsaved sample scene";
  $("cancel").disabled = !busy;
  $("scene").disabled = !ready || busy;
});

for (const id of ["open", "save", "save-as"]) $(id).addEventListener("click", () => enqueue(async () => {
  await flush();
  await window.styling.action(id);
}));
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    const button = $(event.shiftKey ? "save-as" : "save");
    if (!button.disabled) button.click();
  }
});
window.styling.onProject(({ imagery, height, projectPath }) => {
  $("imagery").checked = imagery;
  $("height").value = height;
  $("project-path").textContent = projectPath || "Unsaved sample scene";
});