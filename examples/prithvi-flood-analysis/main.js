"use strict";

const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { PRITHVI } = require("../common/geoai-profiles");

class PrithviFloodAnalysisExample extends GeoAiExample {
  constructor() { super(PRITHVI); }
}
let example;
async function start() {
  await launch(() => {
    example = new PrithviFloodAnalysisExample();
    return example;
  });
}
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, PrithviFloodAnalysisExample, ID, DATA: PRITHVI.data, MODEL: PRITHVI.model };
