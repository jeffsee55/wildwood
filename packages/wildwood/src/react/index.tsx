"use client";

export { WildwoodJsonView, type WildwoodJsonViewProps } from "./wildwood-json-view";

// NOTE: We intentionally do NOT `export * from "wildwood-kit"` here.
// - `wildwood-kit` is a Client Component library that expects to be imported
//   via `wildwood/nextjs/kit` (Server wrapper) or directly as `wildwood-kit`.
// - Re-exporting it from `wildwood/react` caused Next/Turbopack to merge the
//   server-only `wildwood/nextjs/play-auth` barrel (imported by `app/page.tsx`
//   via `@/lib/auth`) into the same client chunk as `WildwoodJsonView`,
//   triggering `node:module` external errors.
// - Consumers that need both should import separately:
//   `import { Toolbar } from "wildwood/nextjs/kit"` and
//   `import { WildwoodJsonView } from "wildwood/react"`.
// Kept for backwards compat: explicit opt-in re-export guarded by env.
// If you really need the old behavior, import `wildwood-kit` directly.
export * from "wildwood-ui";
