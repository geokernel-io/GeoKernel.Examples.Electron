"use strict";

const { GeoAiExample, launch, ID } = require("../common/geoai-example");
const { GEOAI_USA } = require("../common/geoai-profiles");

class GeoAiUsaBuildingFootprintsExample extends GeoAiExample {
  constructor() { super(GEOAI_USA); }
}
let example;
async function start() {
  await launch(() => {
    example = new GeoAiUsaBuildingFootprintsExample();
    return example;
  });
}
function stop() { if (example) void example.shutdown(); }
module.exports = { start, stop, GeoAiUsaBuildingFootprintsExample, ID, DATA: GEOAI_USA.data, MODEL: GEOAI_USA.model };
