/// <reference types="vitest" />
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `watch` is not a top-level Vite config key — it belongs under `server.watch`
  // Keeping a top-level `watch` made `tsc --noEmit` via vitest fail `No overload matches`.
  // Preserve intent via server.watch only.
  build: {
    lib: {
      entry: "./src/index.ts",
      name: "Wildwood",
    },
    rollupOptions: {
      // typo fix: was `@libqsl/client` — should be `@libsql/client`
      external: ["@libsql/client"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    watch: {
      ignored: ["**/src/tests/fixtures/**"],
    },
  },
  test: {
    hideSkippedTests: true,
    setupFiles: ["dotenv/config"],
    include: ["src/**/*.test.ts"],
    exclude: ["src/tests/fixtures/**/*"],
    printConsoleTrace: true,
  },
});
