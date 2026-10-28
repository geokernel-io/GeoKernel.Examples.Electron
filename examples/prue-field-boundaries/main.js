"use strict";

const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { PRUE } = require("../common/geoai-profiles");

class PrueFieldBoundariesExample extends GeoAiExample {
  constructor() { super(PRUE); }
}
let example;
async function start() {
  await launch(() => {
    example = new PrueFieldBoundariesExample();
    return example;
  });
}
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, PrueFieldBoundariesExample, ID, DATA: PRUE.data, MODEL: PRUE.model };
