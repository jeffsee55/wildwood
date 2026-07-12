import { defineConfig } from "drizzle-kit";

export const url = "file:../../apps/shad-docs/wildwood.db";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/sqlite/schema.ts",
  dbCredentials: {
    url,
  },
});
