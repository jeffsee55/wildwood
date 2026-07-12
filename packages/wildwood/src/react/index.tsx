"use client";

export { WildwoodJsonView, type WildwoodJsonViewProps } from "./wildwood-json-view";

// NOTE: We intentionally do NOT `export * from "wildwood-kit"` here.
// - `wildwood-kit` is a Client Component library that expects to be imported
//   via `tr33/nextjs/kit` (Server wrapper) or directly as `wildwood-kit`.
// - Re-exporting it from `tr33/react` caused Next/Turbopack to merge the
//   server-only `tr33/nextjs/play-auth` barrel (imported by `app/page.tsx`
//   via `@/lib/auth`) into the same client chunk as `WildwoodJsonView`,
//   triggering `node:module` external errors.
// - Consumers that need both should import separately:
//   `import { Toolbar } from "tr33/nextjs/kit"` and
//   `import { WildwoodJsonView } from "tr33/react"`.
// Kept for backwards compat: explicit opt-in re-export guarded by env.
// If you really need the old behavior, import `wildwood-kit` directly.
export * from "wildwood-ui";
