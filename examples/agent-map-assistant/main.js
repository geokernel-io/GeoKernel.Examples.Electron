"use strict";

// Agent Map Assistant: natural-language map requests as validated, previewed and recorded
// workflows. A planner (an LLM, or the offline demo with prepared plans) proposes a workflow
// DSL v2 plan; GeoKernel validates it, the plan is shown before anything runs, steps that
// change data need the user's confirmation of that exact plan, and every executed workflow
// is undoable and recorded with hash-chained provenance. Electron port of the Qt example.

const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { app, BrowserWindow } = require("electron");

// The agent API ships after geokernel-electron 1.5.40. Until then, point
// GEOKERNEL_ELECTRON_MODULE at a GeoKernel.Electron checkout that has it.
const GEOKERNEL_MODULE = process.env.GEOKERNEL_ELECTRON_MODULE || "geokernel-electron";
const geokernel = require(GEOKERNEL_MODULE);
const { GisAgent, ViewerTool, ViewerWindow, findBinDir } = geokernel;

const TITLE = "Agent Map Assistant";
const DATA_DIR = path.join(__dirname, "data");
const CONTROL = Object.freeze({
  REQUESTS: 1, ASK: 2, TYPED: 3, SEND: 4, RUN: 5, CONFIRM: 6, DISCARD: 7, UNDO: 8, PROVENANCE: 9, FULL_EXTENT: 10, PLANNER: 11,
});
// Bottom to top; each new layer becomes index 0.
const LAYERS = [
  ["parks.geojson", { fillColor: "#A1D99B", fillOpacity: 255, lineColor: "#41AB5D", lineWidth: 1.0 }],
  ["streets.geojson", { lineColor: "#9E9E9E", lineWidth: 3.0 }],
  ["buildings.geojson", { fillColor: "#E7D8C3", fillOpacity: 255, lineColor: "#A08B70", lineWidth: 0.8 }],
  ["schools.geojson", { pointColor: "#2171B5", fillColor: "#2171B5", lineColor: "#08306B", pointSize: 12.0, lineWidth: 1.2 }],
];

let viewer = null;
let agent = null;
let keeperWindow = null;
let eventPump = null;
let viewerWasVisible = false;
let viewerHiddenSince = 0;
let closing = false;
let controlsReady = false;
let busy = false;
let typed = "";
let selected = "";
let pending = null; // { proposal, evaluation }
const workflows = [];

const demo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "agent-demo.json"), "utf8"));
const prepared = new Map(demo.requests.map((item) => [item.request.toLowerCase(), JSON.stringify(item.proposal)]));
const provider = (process.env.GEOKERNEL_LLM_PROVIDER || "").trim().toLowerCase();
const model = (process.env.GEOKERNEL_LLM_MODEL || "").trim() || (provider === "anthropic" ? "claude-opus-5-5" : "model not set");
const plannerText = provider ? `${provider} (${model})` : "offline demo (prepared plans)";

function verifyQtPlatformPlugin() {
  const binDir = findBinDir();
  const candidates = [
    process.env.QT_QPA_PLATFORM_PLUGIN_PATH ? path.join(process.env.QT_QPA_PLATFORM_PLUGIN_PATH, "qwindows.dll") : null,
    path.join(binDir, "platforms", "qwindows.dll"),
    path.join(binDir, "plugins", "platforms", "qwindows.dll"),
  ].filter(Boolean);
  if (!candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`GeoKernel Electron runtime is missing Qt platform plugin qwindows.dll: ${binDir}`);
  }
}

function say(who, text) {
  viewer.appendLog(`${who}: ${text}`);
}

function steps(count) {
  return count === 1 ? "1 step" : `${count} steps`;
}

function refreshControls() {
  const ready = Boolean(agent) && !busy;
  const needsConfirmation = Boolean(pending?.evaluation.needsConfirmation.length);
  viewer.setControlEnabled(CONTROL.ASK, ready);
  viewer.setControlEnabled(CONTROL.SEND, ready);
  viewer.setControlEnabled(CONTROL.RUN, ready && Boolean(pending) && !needsConfirmation);
  viewer.setControlEnabled(CONTROL.CONFIRM, ready && needsConfirmation);
  viewer.setControlEnabled(CONTROL.DISCARD, ready && Boolean(pending));
  viewer.setControlEnabled(CONTROL.UNDO, ready && workflows.length > 0);
}

// ------------------------------------------------------------------ planning

function propose(request) {
  const proposal = prepared.get(request.toLowerCase());
  if (!provider) {
    if (proposal) return Promise.resolve({ proposal });
    return Promise.resolve({
      error: "offline demo mode only has plans for the sample requests. Set GEOKERNEL_LLM_PROVIDER "
        + "(anthropic, openai or ollama) and its API key to plan your own requests.",
    });
  }
  const grounding = `${agent.grounding()}\n${demo.groundingNotes}`;
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, "planner-worker.js"), {
      workerData: { module: GEOKERNEL_MODULE, intent: request, grounding, binDir: findBinDir() },
    });
    worker.once("message", resolve);
    worker.once("error", (error) => resolve({ error: error.message }));
  });
}

async function submit(request) {
  request = String(request || "").trim();
  if (!request || busy || !agent) return;
  discard(false);
  say("You", request);
  busy = true;
  viewer.setStatusText(provider ? "Planning..." : "");
  refreshControls();
  const { proposal, error } = await propose(request);
  busy = false;
  viewer.setStatusText("");
  if (!viewer) return;
  if (error) {
    say("Planner", `No plan was proposed: ${error}`);
    refreshControls();
    return;
  }
  preview(proposal);
}

function preview(proposal) {
  const evaluation = agent.evaluate(proposal);
  if (evaluation.status !== "validated" && evaluation.status !== "confirmation-required") {
    const details = evaluation.steps.filter((step) => step.message).map((step) => `${step.stepId}: ${step.message}`).join("; ");
    say("Planner", `The plan was rejected (${evaluation.status}): ${evaluation.message}${details ? ` — ${details}` : ""}`);
    refreshControls();
    return;
  }
  pending = { proposal, evaluation };
  const id = evaluation.planId;
  const summary = evaluation.summary.replace(id, `${id.slice(0, 16)}…`);
  const count = summary.split("\n").length - 1;
  if (evaluation.needsConfirmation.length) {
    say("Planner", `Plan ready. Steps ${evaluation.needsConfirmation.join(", ")} change or delete data; review them, then Confirm and run.`);
    viewer.setStatusText("The plan changes data: review it and click Confirm and run");
  } else {
    say("Planner", `Plan ready (${steps(count)}). Review it and press Run.`);
    viewer.setStatusText("Plan validated: review it and click Run");
  }
  viewer.appendLog(summary);
  refreshControls();
}

// ------------------------------------------------------------------ execution

function runPending() {
  if (!pending || busy) return;
  const { proposal, evaluation } = pending;
  // Clicking Run / Confirm and run is the user's confirmation of this exact plan.
  const confirmed = evaluation.needsConfirmation.length ? evaluation.planId : null;
  const result = agent.run(proposal, confirmed);
  discard(false);
  const completed = result.completedSteps || 0;
  if (completed > 0) workflows.push(completed);
  if (result.report) say("Result", result.report);
  if (result.status === "executed") {
    say("Map", `Done: ${steps(completed)} ran. Provenance ${result.provenanceHash.slice(0, 12)}.`);
    viewer.setStatusText(`Executed ${result.planId.slice(0, 16)}`);
  } else {
    say("Map", `Stopped at step ${result.failedStepId || "-"}: ${result.message}. ${completed} completed steps can be undone.`);
  }
  refreshControls();
}

function discard(log = true) {
  const had = Boolean(pending);
  pending = null;
  if (log && had) {
    say("Planner", "Plan discarded; nothing ran.");
    viewer.setStatusText("");
  }
  if (viewer) refreshControls();
}

function undoLast() {
  if (!workflows.length || busy) return;
  const result = agent.undo(workflows.pop());
  let text = `Undone: ${result.undoneSteps.join(", ")}.`;
  if (result.irreversible?.length) text += ` Could not undo: ${result.irreversible.join("; ")}.`;
  say("Map", text);
  refreshControls();
}

function showProvenance() {
  const records = agent.provenance().records || [];
  if (!records.length) {
    say("Provenance", "No workflow has run yet.");
    return;
  }
  say("Provenance", `${records.length} executed workflow(s), chained by hash:`);
  const short = (value) => String(value || "-").slice(0, 12);
  for (const record of records) {
    viewer.appendLog(`  #${record.sequence} ${record.executionId}: ${record.stepOutputs?.length ?? 0} step outputs, `
      + `output ${short(record.outputSha256)}, hash ${short(record.hash)} <- ${short(record.previousHash)}`);
  }
}

// ------------------------------------------------------------------ window

function onControlChanged(controlId, numericValue, textValue) {
  if (!viewer || !controlsReady) return;
  switch (controlId) {
    case CONTROL.REQUESTS: selected = textValue || demo.requests[Math.round(numericValue)]?.request || selected; break;
    case CONTROL.TYPED: typed = textValue; break;
    case CONTROL.ASK: submit(selected); break;
    case CONTROL.SEND: submit(typed); break;
    case CONTROL.RUN:
    case CONTROL.CONFIRM: runPending(); break;
    case CONTROL.DISCARD: discard(); break;
    case CONTROL.UNDO: undoLast(); break;
    case CONTROL.PROVENANCE: showProvenance(); break;
    case CONTROL.FULL_EXTENT: viewer.fullExtent(); break;
    default: break;
  }
}

function finishAndExit() {
  if (closing) return;
  closing = true;
  stop();
  app.exit(0);
}

function startEventPump() {
  viewerWasVisible = false;
  viewerHiddenSince = 0;
  eventPump = setInterval(() => {
    if (!viewer) return;
    viewer.processEvents();
    if (viewer.isVisible()) { viewerWasVisible = true; viewerHiddenSince = 0; }
    else if (viewerWasVisible) {
      if (viewerHiddenSince === 0) viewerHiddenSince = Date.now();
      if (Date.now() - viewerHiddenSince > 750) finishAndExit();
    }
  }, 16);
}

async function start() {
  if (typeof GisAgent !== "function") {
    throw new Error("This geokernel-electron package has no agent API. AgentMapAssistant needs a release newer than 1.5.40 "
      + "(or GEOKERNEL_ELECTRON_MODULE pointing at a GeoKernel.Electron checkout with it).");
  }
  closing = false;
  verifyQtPlatformPlugin();
  keeperWindow = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, webPreferences: { sandbox: true } });
  viewer = new ViewerWindow({ title: TITLE, width: 1360, height: 820, navigationToolbar: false });
  selected = demo.requests[0].request;
  viewer.addControlPanel({
    title: "Map assistant",
    width: 330,
    controls: [
      { id: CONTROL.REQUESTS, type: "combo", label: "Try", options: demo.requests.map((item) => item.request), value: selected },
      { id: CONTROL.ASK, type: "button", text: "Ask" },
      { id: CONTROL.TYPED, type: "text", label: "Your request", value: "" },
      { id: CONTROL.SEND, type: "button", text: "Send" },
      { id: CONTROL.RUN, type: "button", text: "Run" },
      { id: CONTROL.CONFIRM, type: "button", text: "Confirm and run" },
      { id: CONTROL.DISCARD, type: "button", text: "Discard" },
      { id: CONTROL.UNDO, type: "button", text: "Undo last" },
      { id: CONTROL.PROVENANCE, type: "button", text: "Provenance" },
      { id: CONTROL.FULL_EXTENT, type: "button", text: "Full Extent" },
      { id: CONTROL.PLANNER, type: "text", label: "Planner", value: plannerText, readOnly: true },
    ],
  }, onControlChanged);
  viewer.addLogPanel("Conversation");
  viewer.setTool(ViewerTool.PAN);
  viewer.show();
  viewer.processEvents();
  for (const [file, style] of LAYERS) {
    viewer.addLayerFile(path.join(DATA_DIR, file));
    viewer.setLayerStyle(0, style);
  }
  viewer.refreshLayers();
  viewer.fullExtent();
  agent = new GisAgent(viewer);
  startEventPump();
  controlsReady = true;
  say("Assistant", "Pick a request under Try and click Ask, or type your own and click Send. "
    + "Plans are shown here before anything runs.");
  refreshControls();
}

function stop() {
  if (eventPump) clearInterval(eventPump);
  eventPump = null;
  controlsReady = false;
  if (agent) { try { agent.close(); } catch { /* already closed */ } }
  agent = null;
  if (viewer) { try { viewer.close(); } catch { /* Native window may already be gone. */ } }
  viewer = null;
  if (keeperWindow) keeperWindow.destroy();
  keeperWindow = null;
}

module.exports = { start, stop };
