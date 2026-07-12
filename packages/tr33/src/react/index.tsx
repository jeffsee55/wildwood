"use client";

export { Tr33JsonView, type Tr33JsonViewProps } from "./tr33-json-view";

// NOTE: We intentionally do NOT `export * from "@tr33/kit"` here.
// - `@tr33/kit` is a Client Component library that expects to be imported
//   via `tr33/nextjs/kit` (Server wrapper) or directly as `@tr33/kit`.
// - Re-exporting it from `tr33/react` caused Next/Turbopack to merge the
//   server-only `tr33/nextjs/play-auth` barrel (imported by `app/page.tsx`
//   via `@/lib/auth`) into the same client chunk as `Tr33JsonView`,
//   triggering `node:module` external errors.
// - Consumers that need both should import separately:
//   `import { Toolbar } from "tr33/nextjs/kit"` and
//   `import { Tr33JsonView } from "tr33/react"`.
// Kept for backwards compat: explicit opt-in re-export guarded by env.
// If you really need the old behavior, import `@tr33/kit` directly.
export * from "@tr33/ui";
