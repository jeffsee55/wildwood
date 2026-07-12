#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const GENERATED_SCHEMA_PATH = "src/sqlite/schema.sql";
const SCHEMA_JSON_PATH = "src/sqlite/schema.json";
const EXTRA_SCHEMA_PATHS = ["src/sqlite/better-auth-schema.sql"];
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizeSql(input) {
  return input.trim();
}

function readExtraSchemas() {
  return EXTRA_SCHEMA_PATHS.flatMap((schemaPath) => {
    const resolved = resolve(PACKAGE_ROOT, schemaPath);
    if (!existsSync(resolved)) {
      return [];
    }
    const raw = normalizeSql(readFileSync(resolved, "utf8"));
    return raw ? [`-- ${schemaPath}\n${raw}`] : [];
  });
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
  const schemas = [generatedSchema, ...readExtraSchemas()].filter(Boolean);
  const raw = `${schemas.join("\n\n")}\n`;
  writeFileSync(resolve(PACKAGE_ROOT, GENERATED_SCHEMA_PATH), raw);
  writeFileSync(resolve(PACKAGE_ROOT, SCHEMA_JSON_PATH), JSON.stringify({ raw }));
});
