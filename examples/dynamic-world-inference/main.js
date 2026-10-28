"use strict";

const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { DYNAMIC_WORLD } = require("../common/geoai-profiles");

class DynamicWorldExample extends GeoAiExample {
  constructor() { super(DYNAMIC_WORLD); }
}
let example;
async function start() {
  await launch(() => {
    example = new DynamicWorldExample();
    return example;
  });
}
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, DynamicWorldExample, ID, DATA: DYNAMIC_WORLD.data, MODEL: DYNAMIC_WORLD.model };
