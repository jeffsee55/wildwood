import { defineConfig } from "tsdown";
export default defineConfig([
  {
    entry: ["src/server.ts", "src/sourcemap.ts", "src/auth.ts", "src/next/config.ts"],
    dts: true,
    clean: true,
    external: [
      "next",
      "next/headers",
      "next/cache",
      "next/navigation",
      "react",
      "react/jsx-runtime",
    ],
  },
  {
    entry: ["src/next/bridge.tsx"],
    dts: true,
    clean: false,
    unbundle: true,
    external: ["next/navigation", "react", "react/jsx-runtime"],
    banner: '"use client";',
  },
]);
