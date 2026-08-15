#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATED_SCHEMA_PATH = "src/sqlite/schema.sql";
const SCHEMA_JSON_PATH = "src/sqlite/schema.json";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizeSql(input) {
  return input.trim();
}

// Read from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const generatedSchema = normalizeSql(input);
  if (!generatedSchema) {
    console.error("No generated Wildwood schema received on stdin.");
    process.exit(1);
  }
  const raw = `${generatedSchema}\n`;
  writeFileSync(resolve(PACKAGE_ROOT, GENERATED_SCHEMA_PATH), raw);
  writeFileSync(resolve(PACKAGE_ROOT, SCHEMA_JSON_PATH), JSON.stringify({ raw }));
});
