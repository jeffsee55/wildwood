import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/nextjs/index.ts", "src/react/index.tsx"],
  dts: true,
  outDir: "dist",
  clean: true,
  exports: true,
  /** Bundle workspace store so Next.js apps do not need a direct `tr33-store` dependency. */
  noExternal: ["tr33-store"],
  // This isn't working for ignore tests for some reason
  ignoreWatch: ["tr33.db"],
});
