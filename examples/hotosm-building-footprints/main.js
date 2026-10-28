"use strict";

const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { HOTOSM } = require("../common/geoai-profiles");

class HotosmBuildingFootprintsExample extends GeoAiExample {
  constructor() { super(HOTOSM); }
}
let example;
async function start() {
  await launch(() => {
    example = new HotosmBuildingFootprintsExample();
    return example;
  });
}
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, HotosmBuildingFootprintsExample, ID, DATA: HOTOSM.data, MODEL: HOTOSM.model };
