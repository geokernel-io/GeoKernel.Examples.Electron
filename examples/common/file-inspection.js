"use strict";

function typeName(value) {
  const names = ["String", "Integer", "Double", "Boolean", "DateTime"];
  return typeof value === "number" ? (names[value] ?? String(value)) : String(value ?? "Unknown");
}

function tableRow(values, widths) {
  return values.map((value, index) => {
    const text = String(value ?? "").replace(/\s+/g, " ");
    const width = widths[index];
    return text.length > width ? `${text.slice(0, width - 3)}...` : text.padEnd(width);
  }).join(" | ").trimEnd();
}

function attributeRows(viewer, layerIndex, definitions, maximumRows) {
  const fields = definitions.map((definition) => String(definition.name ?? ""));
  const rows = [];
  for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
    const values = viewer.layerFeatureAttributes(layerIndex, rowIndex);
    if (!values || Object.keys(values).length === 0) break;
    rows.push(values);
  }
  if (rows.length === 0) return ["No attribute rows returned."];

  const widths = [4, ...fields.map((field) => Math.max(12, Math.min(24, field.length + 2)))];
  return [
    tableRow(["#", ...fields], widths),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map((values, rowIndex) => tableRow([
      rowIndex,
      ...fields.map((field) => values[field] ?? ""),
    ], widths)),
  ];
}

function schemaRows(definitions) {
  const widths = [24, 12, 8, 8];
  return [
    tableRow(["Field", "Type", "Length", "Decimals"], widths),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...definitions.map((definition) => tableRow([
      definition.name,
      typeName(definition.type),
      definition.length,
      definition.decimalCount,
    ], widths)),
  ];
}

module.exports = { attributeRows, schemaRows };
