import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/nextjs/index.ts", "src/react/index.tsx"],
  dts: true,
  outDir: "dist",
  clean: true,
  exports: true,
  /** Inlined into tr33 so apps only need `tr33` + prebuilt `@tr33/kit` (client UI). */
  noExternal: ["tr33-store"],
  ignoreWatch: ["tr33.db"],
});
