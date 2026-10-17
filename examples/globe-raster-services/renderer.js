"use strict";
const status = document.getElementById("status");
window.globe.onStatus((message) => {
  status.textContent = message;
  status.title = message;
});
