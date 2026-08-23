import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
  throw new Error("Refusing to reset the docs database outside local development.");
}

if (process.env.TURSO_DATABASE_URL?.trim()) {
  console.log("[wildwood] TURSO_DATABASE_URL is set; leaving the remote database unchanged.");
  process.exit(0);
}

const docsDirectory = fileURLToPath(new URL("..", import.meta.url));
const databaseFiles = ["wildwood-docs.db", "wildwood-docs.db-shm", "wildwood-docs.db-wal"];

await Promise.all(
  databaseFiles.map((filename) =>
    rm(fileURLToPath(new URL(`../${filename}`, import.meta.url)), { force: true }),
  ),
);

console.log(`[wildwood] Reset disposable development database in ${docsDirectory}`);
