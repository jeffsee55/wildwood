import { defineConfig } from "drizzle-kit";

/** SQLite used by the docs app's zero-config local development mode. */
export const url = "file:../../apps/docs/wildwood-docs.db";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/sqlite/schema.ts",
  dbCredentials: {
    url,
  },
});
