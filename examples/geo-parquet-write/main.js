'use strict';

const path = require('node:path');
const modernData = require('geokernel-electron');

async function main() {
  const batch = {
    crs: 'EPSG:4326',
    geometryColumn: 'geometry',
    columns: [
      { name: 'id', type: 1, nullable: false, logicalType: '', values: [1] },
      {
        name: 'geometry',
        type: 5,
        nullable: false,
        logicalType: 'wkb',
        values: ['010100000000000000000024400000000000003440'],
      },
    ],
  };

  const output = path.join(__dirname, 'cities.parquet');
  const result = await modernData.writeGeoParquet(output, [batch], {
    geometryTypes: ['Point'],
  });
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
