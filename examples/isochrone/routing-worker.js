"use strict";

const { ViewerWindow } = require("geokernel-electron");

const EARTH_RADIUS = 6371008.8;
const MERCATOR_LIMIT = 20037508.342789244;

function mercator(point) {
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.y));
  return {
    x: point.x * MERCATOR_LIMIT / 180,
    y: Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * MERCATOR_LIMIT / Math.PI,
  };
}

function distance(first, second) {
  const lat1 = first.y * Math.PI / 180;
  const lat2 = second.y * Math.PI / 180;
  const dlat = lat2 - lat1;
  const dlon = (second.x - first.x) * Math.PI / 180;
  const value = Math.sin(dlat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

class Heap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent][0] <= item[0]) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    const result = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1][0] < this.items[child][0]) child += 1;
        if (this.items[child][0] >= last[0]) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return result;
  }
}

class Engine {
  constructor(json) {
    const graph = JSON.parse(json);
    this.nodes = new Map(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    this.out = new Map();
    this.edgeRecords = [];
    this.worldGeometry = new Map();
    for (const edge of graph.edges) {
      const speed = edge.speedKmh > 0 ? edge.speedKmh : 50;
      const travelTime = edge.distance / (speed * 1000 / 3600);
      if (!this.out.has(edge.from)) this.out.set(edge.from, []);
      this.out.get(edge.from).push([edge.to, travelTime]);
      const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
      this.edgeRecords.push([edge.from, edge.to, key]);
      if (!this.worldGeometry.has(key) && (edge.geometry?.length ?? 0) >= 2) {
        this.worldGeometry.set(key, {
          from: edge.from, to: edge.to,
          points: edge.geometry.map(([x, y]) => mercator({ x, y })),
        });
      }
    }
    this.component = this.largestComponent();
  }

  largestComponent() {
    const visited = new Set();
    let largest = new Set();
    for (const seed of this.nodes.keys()) {
      if (visited.has(seed)) continue;
      const component = new Set([seed]);
      const queue = [seed];
      visited.add(seed);
      for (let index = 0; index < queue.length; index += 1) {
        for (const [neighbor] of this.out.get(queue[index]) ?? []) {
          if (!visited.has(neighbor)) { visited.add(neighbor); component.add(neighbor); queue.push(neighbor); }
        }
      }
      if (component.size > largest.size) largest = component;
    }
    return largest;
  }

  calculate(point) {
    let originId = null;
    let snapDistance = 2000;
    for (const id of this.component) {
      const current = distance(point, this.nodes.get(id));
      if (current < snapDistance) { originId = id; snapDistance = current; }
    }
    if (originId == null) return null;
    const costs = new Map([[originId, 0]]);
    const queue = new Heap();
    queue.push([0, originId]);
    while (queue.size) {
      const [cost, node] = queue.pop();
      if (cost > (costs.get(node) ?? Infinity) || cost > 900) continue;
      for (const [neighbor, travelTime] of this.out.get(node) ?? []) {
        const candidate = cost + travelTime;
        if (candidate > 900 || candidate >= (costs.get(neighbor) ?? Infinity)) continue;
        costs.set(neighbor, candidate);
        queue.push([candidate, neighbor]);
      }
    }
    const bandEdges = [[], [], []];
    const drawn = [new Set(), new Set(), new Set()];
    const edgeCounts = [0, 0, 0];
    for (const [from, to, key] of this.edgeRecords) {
      if (!costs.has(from) || !costs.has(to) || !this.worldGeometry.has(key)) continue;
      const value = Math.max(costs.get(from), costs.get(to));
      const band = value <= 300 ? 0 : value <= 600 ? 1 : value <= 900 ? 2 : -1;
      if (band < 0) continue;
      edgeCounts[band] += 1;
      if (!drawn[band].has(key)) { drawn[band].add(key); bandEdges[band].push(this.worldGeometry.get(key)); }
    }
    const limits = [300, 600, 900];
    const cumulativeNodes = limits.map((limit) => {
      let count = 0;
      for (const value of costs.values()) if (value <= limit) count += 1;
      return count;
    });
    return {
      origin: mercator(this.nodes.get(originId)), snapDistance,
      bands: bandEdges.map((edges, index) => ({
        parts: mergeTrails(edges), cumulativeNodes: cumulativeNodes[index], edgeCount: edgeCounts[index],
      })),
    };
  }
}

function mergeTrails(edges) {
  if (!edges.length) return [];
  const adjacency = new Map();
  const unused = new Uint8Array(edges.length); unused.fill(1);
  const cursor = new Map();
  const add = (node, edgeIndex) => {
    if (!adjacency.has(node)) adjacency.set(node, []);
    adjacency.get(node).push(edgeIndex);
  };
  edges.forEach((edge, index) => { add(edge.from, index); add(edge.to, index); });
  const nextUnused = (node) => {
    const values = adjacency.get(node) ?? [];
    let index = cursor.get(node) ?? 0;
    while (index < values.length && !unused[values[index]]) index += 1;
    cursor.set(node, index + 1);
    return index < values.length ? values[index] : -1;
  };
  const append = (target, points) => {
    for (const point of points) {
      const last = target.at(-1);
      if (!last || last.x !== point.x || last.y !== point.y) target.push(point);
    }
  };
  const parts = [];
  const starts = [...adjacency.keys()].sort((left, right) => (adjacency.get(right).length % 2) - (adjacency.get(left).length % 2));
  let remaining = edges.length;
  for (let startIndex = 0; remaining > 0; startIndex += 1) {
    let start = starts[startIndex % starts.length];
    let edgeIndex = nextUnused(start);
    if (edgeIndex < 0) {
      edgeIndex = unused.findIndex((value) => value !== 0);
      if (edgeIndex < 0) break;
      start = edges[edgeIndex].from;
    }
    const line = [];
    let node = start;
    while (edgeIndex >= 0) {
      unused[edgeIndex] = 0; remaining -= 1;
      const edge = edges[edgeIndex];
      if (edge.from === node) { append(line, edge.points); node = edge.to; }
      else { append(line, [...edge.points].reverse()); node = edge.from; }
      edgeIndex = nextUnused(node);
    }
    if (line.length > 1) parts.push(line);
  }
  return parts;
}

let engine = null;
function send(message) { if (process.connected) process.send(message); }

function initialize(shapefile) {
  let graphViewer = null;
  try {
    graphViewer = new ViewerWindow({ title: "Isochrone graph builder", width: 320, height: 240, navigationToolbar: false });
    graphViewer.addLayer(shapefile);
    graphViewer.setLayerCoordinateSystemPreset(0, "EPSG:4326");
    if (!graphViewer.buildRoutingGraphForLayer(0, {
      snapTolerance: 1e-6, undirected: true, speedFieldName: "maxspeed",
      nameFieldName: "name", oneWayFieldName: "oneway", defaultSpeedKmh: 50,
    })) throw new Error("Routing graph could not be built.");
    const graphJson = graphViewer.getRoutingGraphJson();
    if (!graphJson) throw new Error("Routing graph is unavailable.");
    graphViewer.close(); graphViewer = null;
    engine = new Engine(graphJson);
    if (!engine.component.size) throw new Error("The main connected road network could not be identified.");
    send({ type: "ready", nodes: engine.nodes.size, edges: engine.edgeRecords.length });
  } catch (error) {
    try { graphViewer?.close(); } catch { /* Native viewer may already be gone. */ }
    send({ type: "error", message: error.message });
  }
}

process.on("message", (message) => {
  try {
    if (message.type === "initialize") initialize(message.shapefile);
    else if (message.type === "calculate" && engine) {
      send({ type: "result", id: message.id, result: engine.calculate(message.point) });
    }
  } catch (error) { send({ type: "error", id: message.id, message: error.message }); }
});
process.on("disconnect", () => process.exit(0));
