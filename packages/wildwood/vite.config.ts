/// <reference types="vitest" />
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  watch: {
    ignored: ["**/src/tests/fixtures/**"],
  },
  build: {
    lib: {
      entry: "./src/index.ts",
      name: "Wildwood",
    },
    rollupOptions: {
      external: ["@libqsl/client"],
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
