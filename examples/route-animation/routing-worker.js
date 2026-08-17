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
    this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    this.edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
    this.out = new Map();
    this.neighbors = new Map();
    for (const edge of graph.edges) {
      if (!this.out.has(edge.from)) this.out.set(edge.from, []);
      if (!this.neighbors.has(edge.from)) this.neighbors.set(edge.from, []);
      this.out.get(edge.from).push(edge);
      this.neighbors.get(edge.from).push(edge.to);
    }
    this.component = this.largestComponent();
  }

  largestComponent() {
    const visited = new Set();
    let largest = new Set();
    for (const seed of this.nodes.keys()) {
      if (visited.has(seed)) continue;
      const component = new Set();
      const queue = [seed];
      visited.add(seed);
      for (let index = 0; index < queue.length; index += 1) {
        const node = queue[index];
        component.add(node);
        for (const neighbor of this.neighbors.get(node) ?? []) {
          if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
        }
      }
      if (component.size > largest.size) largest = component;
    }
    return largest;
  }

  reachable(start) {
    const result = new Set([start]);
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      for (const neighbor of this.neighbors.get(queue[index]) ?? []) {
        if (!result.has(neighbor)) { result.add(neighbor); queue.push(neighbor); }
      }
    }
    return result;
  }

  nearest(candidates, point) {
    let nearest = null;
    let minimum = 2000;
    for (const id of candidates) {
      const node = this.nodes.get(id);
      const current = node ? distance(point, node) : Infinity;
      if (current < minimum) { nearest = node; minimum = current; }
    }
    return nearest ? { node: nearest, distance: minimum } : null;
  }

  route(start, finish) {
    const costs = new Map([[start, 0]]);
    const previous = new Map();
    const queue = new Heap();
    queue.push([0, start]);
    while (queue.size) {
      const [cost, node] = queue.pop();
      if (cost > (costs.get(node) ?? Infinity)) continue;
      if (node === finish) break;
      for (const edge of this.out.get(node) ?? []) {
        const candidate = cost + edge.distance;
        if (candidate >= (costs.get(edge.to) ?? Infinity)) continue;
        costs.set(edge.to, candidate);
        previous.set(edge.to, edge);
        queue.push([candidate, edge.to]);
      }
    }
    if (!costs.has(finish)) return null;
    const edgeIds = [];
    let node = finish;
    while (node !== start) {
      const edge = previous.get(node);
      if (!edge) return null;
      edgeIds.unshift(edge.id);
      node = edge.from;
    }
    const geometry = [];
    let totalDistance = 0;
    let time = 0;
    for (const id of edgeIds) {
      const edge = this.edges.get(id);
      totalDistance += edge.distance;
      if (edge.speedKmh > 0) time += edge.distance / (edge.speedKmh * 1000 / 3600);
      for (const coordinate of edge.geometry ?? []) {
        const point = mercator({ x: coordinate[0], y: coordinate[1] });
        const last = geometry.at(-1);
        if (!last || last.x !== point.x || last.y !== point.y) geometry.push(point);
      }
    }
    if (geometry.length < 2) return null;
    const steps = [];
    for (const id of edgeIds) {
      const edge = this.edges.get(id);
      const name = String(edge.attributes?.name ?? "").trim() || "Unnamed road";
      const last = steps.at(-1);
      if (last && last.name.toLowerCase() === name.toLowerCase()) last.distance += edge.distance;
      else steps.push({ name, distance: edge.distance });
    }
    return { geometry, distance: totalDistance, time, steps };
  }

  select(point, start) {
    const snapped = this.nearest(start == null ? this.component : this.reachable(start), point);
    if (!snapped) return { snapped: null, route: null };
    return {
      snapped: { id: snapped.node.id, world: mercator(snapped.node), distance: snapped.distance },
      route: start == null ? null : this.route(start, snapped.node.id),
    };
  }
}

let engine = null;
function send(message) { if (process.connected) process.send(message); }

function initialize(shapefile) {
  let graphViewer = null;
  try {
    graphViewer = new ViewerWindow({ title: "RouteAnimation graph builder", width: 320, height: 240, navigationToolbar: false });
    graphViewer.addLayer(shapefile);
    graphViewer.setLayerCoordinateSystemPreset(0, "EPSG:4326");
    if (!graphViewer.buildRoutingGraphForLayer(0, {
      snapTolerance: 1e-6,
      undirected: true,
      speedFieldName: "maxspeed",
      nameFieldName: "name",
      oneWayFieldName: "oneway",
      defaultSpeedKmh: 50,
    })) throw new Error("Routing graph could not be built.");
    const json = graphViewer.getRoutingGraphJson();
    if (!json) throw new Error("Routing graph is unavailable.");
    graphViewer.close(); graphViewer = null;
    engine = new Engine(json);
    if (!engine.component.size) throw new Error("The main connected road network could not be identified.");
    send({ type: "ready", nodes: engine.nodes.size, edges: engine.edges.size });
  } catch (error) {
    try { graphViewer?.close(); } catch { /* Native viewer may be gone. */ }
    send({ type: "error", message: error.message });
  }
}

process.on("message", (message) => {
  try {
    if (message.type === "initialize") initialize(message.shapefile);
    else if (message.type === "select" && engine) send({ type: "selection", id: message.id, ...engine.select(message.point, message.start) });
  } catch (error) { send({ type: "error", id: message.id, message: error.message }); }
});
process.on("disconnect", () => process.exit(0));
