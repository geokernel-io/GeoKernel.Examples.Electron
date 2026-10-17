"use strict";
for (const button of document.querySelectorAll("button")) {
  button.addEventListener("click", () => window.globe.change(
    button.dataset.mode === undefined ? button.dataset.action : Number(button.dataset.mode)));
}
window.globe.onState(state => {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = !state.loaded;
    if (button.dataset.mode !== undefined)
      button.setAttribute("aria-pressed", String(Number(button.dataset.mode) === state.mode));
  }
  document.getElementById("result").textContent = state.result;
  document.getElementById("status").textContent = state.status;
  document.getElementById("status").title = state.status;
});
