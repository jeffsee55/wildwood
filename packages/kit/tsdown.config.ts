import { defineConfig } from "tsdown";
import type { Plugin } from "rolldown";
import { execFileSync } from "child_process";
import path from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const cssInput = path.resolve(__dirname, "src/index.css");
const tailwindBin = path.resolve(__dirname, "node_modules/.bin/tailwindcss");

function compileKitTailwind(): string {
  return execFileSync(tailwindBin, ["-i", cssInput, "--minify"], {
    cwd: __dirname,
    encoding: "utf-8",
  });
}

function tailwindPlugin(): Plugin {
  return {
    name: "tailwind-inline",
    transform(_code, id) {
      if (!id.includes("index.css") || !id.includes("?inline")) return null;
      if (id.includes("node_modules")) return null;
      // Run Tailwind on each bundle so `dist` always matches `src/**/*.tsx` (via `@source` in index.css).
      return compileKitTailwind();
    },
  };
}

export default defineConfig({
  platform: "neutral",
  entry: "./src/lib/index.tsx",
  dts: { build: true },
  exports: true,
  plugins: [tailwindPlugin()],
  deps: {
    // Bundle `@tr33/shared` (pure JS / ~3KB) so consumers don't need `transpilePackages`.
    alwaysBundle: [/@tr33\/shared/, /sonner.*\.css/],
    // Keep React + Next external to guarantee single React copy (fixes useRef-of-null).
    neverBundle: ["react", "react-dom", "react/jsx-runtime", "next", "next/navigation", "next/link"],
  },
});
