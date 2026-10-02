import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/index.ts", "src/git.ts", "src/filesystem.ts"],
  dts: true,
  clean: true,
});
