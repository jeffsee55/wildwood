import { defineConfig } from "tsdown";

import path from "node:path";

type ChunkInfo = { name: string; facadeModuleId?: string | null };

export default defineConfig([
  // ── main library (everything except client-boundary) ─────────────────
  {
    entry: [
      "src/index.ts",
      "src/nextjs/index.ts",
      "src/nextjs/handler.ts",
      "src/nextjs/route.ts",
      "src/nextjs/branch.ts",
      "src/nextjs/draft.ts",
      "src/nextjs/kit.ts",
      "src/nextjs/resolve-active-ref.ts",
      // isolated — has heavy / native deps, must not be imported by docs
      "src/nextjs/play-auth.ts",
      "src/react/index.tsx",
      "src/react/markdown.tsx",
    ],
    dts: true,
    outDir: "dist",
    clean: true,
    exports: true,
    // `wildwood-store` and `wildwood-shared` are pure ESM/JS — always bundle for
    // consumers. Do NOT bundle `wildwood-kit` — it has `'use client'` and must
    // stay a true peer so the consumer's bundler sees its directives.
    //
    // IMPORTANT: `wildwood-ui` is NOT bundled here — `wildwood/react/index.tsx`
    // no longer re-exports it. The previous re-export emitted
    //   [UNRESOLVED_IMPORT] Could not resolve 'wildwood-ui'
    // which caused Turbopack NFT to treat the handler -> route chain as
    // "unexpected file" and fail builds. If ui primitives are needed, import
    // them directly from `wildwood-ui` (peer) or `wildwood/nextjs/kit`.
    //
    // `@uiw/react-json-view` is a real dependency used by `WildwoodJsonView`.
    // It IS bundled into `wildwood/react` so a bare `wildwood` install does not
    // require the consumer to install uiw.
    noExternal: [
      "wildwood-store",
      "wildwood-shared",
      "@uiw/react-json-view",
      "@uiw/react-json-view/dark",
      "@uiw/react-json-view/light",
    ],
    external: [
      "next/headers",
      "next/cache",
      "next/server",
      "next/dynamic",
      "next/link",
      "wildwood-kit",
      // Native / heavy — play-only
      "better-sqlite3",
      "better-auth",
      "better-auth/next-js",
      "kysely",
      "@libsql/client",
      "@libsql/kysely-libsql",
      // client-boundary is a separate config below (emits dist/nextjs/client-boundary.*)
      "./client-boundary",
      "../nextjs/client-boundary",
      "./src/nextjs/client-boundary",
    ],
    ignoreWatch: ["wildwood.db"],
  },
  // ── client-boundary — MUST preserve `'use client'` directive ──────────
  // Turbopack validates `dynamic(...,{ssr:false})` only inside files that
  // start with `'use client'`. rolldown strips directives when bundling
  // chunks, so we emit this as its own unbundled ESM file.
  {
    entry: { "nextjs/client-boundary": "src/nextjs/client-boundary.tsx" },
    dts: true,
    outDir: "dist",
    clean: false,
    format: "esm",
    unbundle: true,
    platform: "browser",
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "next/dynamic",
      "wildwood-kit",
    ],
    hooks: {
      "build:done": async () => {
        const { readFile, writeFile } = await import("node:fs/promises");
        // unbundle emits nextjs/client-boundary.js (ESM, package is type:module)
        const outDir = "dist";
        for (const name of ["nextjs/client-boundary.js", "nextjs/client-boundary.mjs"]) {
          const file = path.join(outDir, name);
          try {
            const src = await readFile(file, "utf8");
            if (!src.startsWith("'use client'") && !src.startsWith('"use client"')) {
              await writeFile(file, `'use client';\n${src}`, "utf8");
              console.info(`[wildwood] ensured 'use client' in ${name}`);
            }
            break;
          } catch {
            // try next extension
          }
        }
      },
    },
  },
]);
