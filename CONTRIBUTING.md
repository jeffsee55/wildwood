# Contributing

Use Node.js 24 and pnpm 10.33.0. The supported path is `wildwood-core` → `wildwood-web` → `apps/docs`.

Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` before deploying. The docs app must exercise public package entry points. Add regression tests for authorization, concurrency, retry, or publication changes.

Content schemas live in `apps/docs/lib/content.ts`. Seed documents live in `apps/docs/content`. Editing a schema's meaning requires a content generation version bump. Physical SQL changes require a compatible migration; adding a table uses idempotent DDL. Never treat production content or auth databases as rebuildable indexes.

MCP tools belong in `packages/web/src/content-tools.ts`. Enforce authorization at the operation boundary, validate schema-backed paths and explicitly authorize unmodeled asset operations, bound inputs, preserve optimistic concurrency, and return structured results with actionable errors. Do not expose raw core APIs as unauthenticated HTTP endpoints.

The toolbar is built and served by `wildwood-web`. The small Next bridge is the only host-compiled editor code. Avoid coupling the host application to toolbar internals.
