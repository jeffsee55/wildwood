import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/extension.ts",
  dts: false,
  hash: false,
  format: "cjs",
  // Force `.js` (not `.cjs`) so `main`/`browser` and copy-bundled-extension.mjs
  // resolve dist/extension.js. tsdown 0.22 defaults CJS output to `.cjs`.
  outExtensions: () => ({ js: ".js" }),
  outDir: "dist",
  clean: true,
  deps: { alwaysBundle: [/wildwood-store/, /wildwood-shared/], neverBundle: ["vscode"] },
});
