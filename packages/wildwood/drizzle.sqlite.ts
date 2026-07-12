import { defineConfig } from "drizzle-kit";

export let url = "file:./wildwood.db";

const optionalUrl = process.env.DB_URL;
if (optionalUrl) {
  url = optionalUrl.startsWith("file:") ? optionalUrl : `file:${optionalUrl}`;
  console.log(`Using database at ${url}`);
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/sqlite/schema.ts",
  dbCredentials: {
    url,
  },
});
