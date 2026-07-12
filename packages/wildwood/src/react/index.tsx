"use client";

export { WildwoodJsonView, type WildwoodJsonViewProps } from "./wildwood-json-view";

// Previously: `export * from "wildwood-ui"` (and later `export { Toolbar } from "wildwood-ui"`)
// Both caused tsdown to emit UNRESOLVED_IMPORT warnings because `wildwood-ui`
// was not declared in `package.json#dependencies` and tsdown treated it as
// external. Turbopack's NFT tracer then saw an unresolved bare specifier
// transitively reachable from `apps/docs/next.config.ts -> dist/handler -> dist/route`
// and flagged the entire monorepo as "unexpected file", crashing prerender.
//
// The docs app does not need this re-export at all — `Toolbar` is imported
// from `wildwood/nextjs/kit` (which owns its own client-boundary).
// Keep `wildwood/react` focused: only JSON view (+ future react-only utils).

// No ui re-exports. If you need Toolbar, import `Toolbar` from `wildwood/nextjs/kit`.
