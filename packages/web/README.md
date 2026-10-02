# Wildwood web integration

`wildwood-web` connects the immutable core to a packaged editing interface. The
browser application is built by this package, not by the consuming Next app.
The docs app is the executable integration example.

## Rendering and mutations

1. Query a document and wrap the result with `withSourcemap(repository, document)`.
2. Add `{...sourcemap(document, 'title')}` to any rendered element. References get
   their own document maps, so an author byline opens the author's source.
3. Mount `Toolbar` from `wildwood-web/next` with the server's state, asset URL,
   and a host Server Action.
4. The prebuilt toolbar dispatches a command to the tiny Next client bridge.
5. The bridge invokes the Server Action. The server derives identity and view
   from verified sessions, validates the source map, saves through the core,
   and calls `revalidatePath`. React obtains fresh RSC output.

The toolbar never substitutes authored text, Markdown, or page HTML. It only
renders its own controls. Raw source edits are parsed and validated on the server.
A rejected save leaves the ref unchanged. No client Markdown parser is shipped.
The map contains repository, physical file, canonical file, snapshot, schema
version, variant context, and field path. It is a locator, not a credential.
A stale map cannot silently save against a newer snapshot. A field path labels
where the edit originated; this release edits the complete source document.
Computed fields are not automatically writable; only annotate source-backed fields.

For suffix variants the editor explicitly offers a new override when a selected
variant falls back to the canonical file. Folder-variant creation and structured
field editing are not implemented. Existing folder-variant source files can be edited.

## Package-served assets and pages

`npm run build` compiles the React toolbar with esbuild and its Tailwind CSS with
the package-owned CLI, then embeds the output in a generated registry of strings.
The toolbar reuses the original shadcn Button and DropdownMenu components, backed
by Base UI. Popovers and editor dialogs also use Base UI, with portals inside the
Shadow DOM for styling and focus isolation. Its private React runtime is bundled.
Build dependencies are not imported by the host application. The
server serves those exact bytes from `/cms/assets/<hash>/<name>`, with ETags,
correct content types, `nosniff`, and `public, max-age=31536000, immutable`.
There is no public-directory copying, stylesheet import into the host bundle,
React peer runtime for the toolbar, or runtime search for asset directories.

The optional Next bridge is a small client component that loads the prebuilt
module and forwards commands to a Server Action. The host compiles that adapter,
not the toolbar/editor/admin application. Other frameworks can call the same
server commands and implement their own refresh bridge.

Sign-in, OAuth consent, device approval, access management, and snapshot review
are HTML responses with package-served CSS/JS. Personalized pages and responses
are private/no-store. Asset serving itself does not initialize authentication.
The stylesheet is isolated inside the toolbar's Shadow DOM. Toolbar controls,
popovers, and dialogs follow the OS light/dark preference automatically, including
changes while the page is open; no theme state or host theme provider is needed.

The host must allow the asset origin in its CSP. Deployments that cache HTML
across releases need to retain referenced asset versions or provide deployment
skew protection; the current registry includes the current package build only.

## Identity and permissions

`createWeb` accepts an identity adapter. `createIdentity` in `wildwood-web/auth`
provides a Better Auth integration with GitHub, OAuth, and device authorization.
It initializes the provider's SQLite schema separately from content tables.
A canonical origin is required; issuer and redirect URLs are not inferred from
untrusted request Host headers. Provider cookies are owned by Better Auth.
The initial owner must match a configured, verified email address. Other signed-in
accounts begin as readers and can request editing access. Owners approve requests.

With `createIdentity({ development: true, ... })`, local sign-in creates a real
Better Auth session for a development owner and continues the standard OAuth
flow. It requires a loopback canonical origin and is disabled in production.
The shortcut replaces external identity verification only; PKCE, consent, token
exchange, refresh, audience checks, and CMS permissions are real. The older
local-session endpoint remains for installations without an identity adapter.

Draft view selections require both the view token and the owning user's session.
Preview shares are independent, read-only bearer grants. The landing handler
exchanges the link for a separate HttpOnly session, strips it from the URL, and
checks the parent share on subsequent requests. Revocation therefore invalidates
already-open sessions on their next server request. Previously received content
cannot be revoked from a recipient's memory or browser cache.

Pinned shares retain snapshot, generation, and variants. Moving shares explicitly
follow a ref while retaining generation and variants. A valid share never grants
editing or publication. Share and agent records store token hashes, not raw tokens.
The host's action adapter must derive the view server-side, never accept an actor
or view supplied by the browser, and set secure cookies on HTTPS deployments.

## Review and publication

The package serves a prebuilt React/shadcn review workspace at `/cms/review`.
It supports file navigation, unified and side-by-side source diffs, word changes,
revision history, file-scoped comments, approval and requested changes, pinned
before/after previews, reviewer invitations, and publication handoffs. Binary,
mode-only, oversized, added, and deleted files have explicit states. Files load on
demand; text diffs are limited to 512 KiB per side and bounded computation time.
Diff rendering is memoized so writing a comment does not recompute it.

New toolbar edits record their same-origin page URL, schema generation, and variant
in `ww_web_edit_context`, separately from content. Review revisions freeze the
known pages for each changed file; the summary and file diff offer links to pinned
before/after previews at those routes. Multiple pages are retained and deduplicated.
Common credential query parameters are stripped. This is navigation context, not
an exhaustive list of pages affected by a document. Historical edits and imports
without page context have no links. Context is recorded after the content mutation;
a process failure between those writes can leave an edit without navigation context.

`createWeb` requires an explicit published ref, for example
`createWeb({ ref: "production", ... })`. There is no default. Every new draft starts from that ref's current snapshot, even when
created while viewing another draft. Published reads, review target checks,
publication, and unscoped agent reads use this same ref.

Publication permanently locks the draft ref and moves it to the toolbar's
**Completed** list, which opens its retained review. Existing draft sessions return
to published content on the next read. A new draft is required for further edits.
The lock is checked inside the core ref-update transaction, so editor and agent
writes cannot race past publication. Publication reserves the lock while landing;
a confirmed target conflict releases that reservation. Retrying an already
completed mutation remains idempotent. The host controls cache policy. The docs app resolves the live ref on every request and caches documents by snapshot, so publication is visible without a rebuild.

`review` submits the current draft to a durable stable review URL. Repeated
submission of the same snapshot/context is idempotent; new snapshots create
immutable revisions. Decisions reference a revision, and an earlier approval
cannot authorize a newer revision. Current native policy requires at least one
approval and no outstanding requests for changes. Owners can approve; an owner
can invite a signed-in reviewer with either comment or approval permission.
Invitations are one-identity claims, expire, and can be revoked. Reviewer previews
are also identity-bound and recheck access on each server read.

Only owners can publish or issue a 10-minute publication credential. It exposes
only MCP `get_review` and `publish_review`, is pinned to one review revision and
repository/audience, and cannot edit or approve. New operations require an
unexpired grant; already-reserved operations can be reconciled after expiry.
Revocation blocks further credential use; an in-flight operation may complete.
The owner can also reconcile an uncertain publication from the UI.

Publication reserves the exact revision durably, blocks concurrent review
updates, then uses the core's idempotent target compare-and-swap. The target must
still match its original snapshot and revision. A confirmed conflict releases the
reservation. An uncertain failure retains it for reconciliation with the same
operation key. Review metadata and the core mutation are separate transactions;
the reservation/reconciliation protocol bridges them. There is no automatic
three-way merge. Decisions remain historical evidence after access expires or
is revoked; revocation prevents new decisions, not retroactive removal.

For externally controlled repositories configure
`reviewAuthority: { kind: 'external', label: 'GitHub' }`. This disables native
publication and publication grants server-side. It is a safety boundary, not a
GitHub integration: PR creation/sync, native GitHub reviews, required-check
reporting, and merge queues are not yet implemented in this package. The legacy runtime and its GitHub adapter have been removed. Git interoperability remains an optional core adapter.

Current limits: comments attach to files/revisions, not individual lines; no
thread resolution, structured frontmatter comparison, per-review title editing,
"changes since last review", or host-deployment status integration yet. Review
manifests and activity are stored as JSON aggregates in `ww_web_review_data`;
large review histories will need paginated rows. Old temporary review IDs are
not migrated; submit the draft again to create its durable review.

## MCP and discovery

`/cms/mcp` implements stateless Streamable HTTP using the MCP SDK.

The toolbar's **Connect agent** shows the MCP URL. Add it to an OAuth-capable
harness; the harness opens sign-in and consent, exchanges the authorization code
using PKCE, sends bearer headers, and refreshes tokens. No manual credential UI
is needed. Configure `createIdentity` even locally (as the docs do).

- Consent displays requested scopes, checked by default for editors: content reads,
  content writes, draft creation, and continued access (`offline_access`). Users
  can narrow these. Readers cannot approve writes or creation. Permission checks
  also resolve the current account role at every MCP request.
- Consent optionally includes one existing owned draft. Otherwise, content writes
  are limited to drafts created by this connection. A connection is scoped to the
  user/client pair and repository; other connections' drafts are inaccessible.
- `create_draft` uses an idempotent command key and branches from the configured
  published ref. Pass its returned `draft` ID to content/review tools. The connection
  and its authorized draft IDs survive access-token refresh. No-draft reads use
  published content; writes require a selected authorized draft.
- Access tokens expire and refresh through the auth provider. The CMS authorization
  persists until revoked in **Manage access**; revocation blocks existing and
  refreshed tokens. Completed drafts remain read-only. An agent cannot approve,
  publish, or delegate access. Publication handoffs remain a separate capability.
- The provider validates the signed consent query, requested scopes, PKCE, and
  token audience. CMS permissions are stored only after successful consent and
  intersected with each token's scopes; narrower tokens never inherit broader
  stored permissions. OAuth client registration is rate limited.
- Legacy manually issued tokens remain supported, including their original
  permissions and revocation behavior, but the toolbar no longer issues them.
  Device sign-in alone does not establish a CMS editing connection.

The integration test uses an actual local HTTP server and auth database to exercise
discovery, dynamic client registration, local sign-in, signed consent, PKCE token
exchange, refresh, scoped draft creation/writes, narrowed scopes, and revocation.
GitHub login still requires provider credentials and has not been verified against
GitHub in this run.

The Next config wrapper is optional:

```ts
import { withWildwood } from 'wildwood-web/next/config';
export default withWildwood(nextConfig, { mcpDiscovery: true });
```

It merges only the two path-scoped metadata rewrites and preserves existing
rewrites. No transpilation/externalization settings are added. Alternatively,
mount the discovery routes yourself. The bare origin-root discovery paths are
not claimed. The docs explicitly opt into these rewrites.

## Current limits

The service currently uses the core's SQLite SQL adapter. Authorization records
are repository-scoped but SQL dialect portability has not been implemented.
Vercel deployment, remote database reads, and canonical OAuth discovery have been exercised. GitHub login still requires a configured client secret and an interactive verification.
Generic cross-origin/deployment credential exchange, group policy, editor-access revocation UI, and three-way merging remain future work. Visible signed-in moving views poll for external changes every five seconds and refresh through RSC. Pinned views do not move. No authored HTML is patched optimistically.

Tests exercise source-map validation, draft isolation, rejected writes, pinned
shares, expiry, revocation, account isolation, idempotent publication conflicts,
static asset caching, MCP credential enforcement, optional routing, and auth
schema/discovery initialization. Browser checks exercise the docs' real RSC bridge.

## Content selection indicator

Edit mode stays enabled across opening, closing, and saving documents. A visible
control beside the leaf turns it off directly; Escape turns it off when no dialog
or popover is open. Opening a surface suspends picking without clearing intent.
Losing editing permission clears it.

Selection mode installs a document stylesheet that outlines the innermost hovered
`data-ww-contentmap` element. The outline is inset, takes no layout space, and
follows the actual box through document/nested scrolling, sticky positioning,
transforms, resizing, and DOM replacement. No bounding-box reads, scroll handlers,
per-frame loops, target attributes, or mutation/resize observers are used by the
indicator. The browser still performs normal hover style matching and painting.
Removing selection mode removes the stylesheet and restores authored outlines.

Annotate an element that generates a visible CSS box. `display: contents` wrappers
have no box to outline; put the map on a visible child instead. Ancestor clipping
and occlusion apply naturally. The selector handles this document's light DOM;
iframe documents and content inside shadow roots need their own integration.
A floating label or drag handles would need a separate positioning strategy.

Research: [Tina's CSS click-to-edit styling](https://tina.io/docs/contextual-editing/tinafield),
[CSS outline layout behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/outline),
[Sanity's observer-based overlays](https://www.sanity.io/docs/visual-editing/visual-editing-overlays),
and [Floating UI's update strategy](https://floating-ui.com/docs/autoupdate).

## Content tools and operations

`content-tools.ts` owns discovery, schema resources, an editing prompt, document search, reference lookup, raw reads/writes, atomic batches, dry-run validation, snapshot validation across all locales, top-level field edits, change summaries, audit history, restoration, and pinned preview links. Results carry both `structuredContent` and compatible JSON text. Tool errors include stable codes and recovery guidance.

MCP writes are restricted to declared collections and require an expected revision plus an idempotency key. The HTTP request body is bounded to 1 MiB, file input to 128 KiB of text, batches to 50 files, and authenticated connections to 120 requests per minute using durable database counters. Foreign browser origins are rejected. Use native remote-MCP clients rather than unauthenticated cross-origin browser calls.

`/cms/connect` provides the canonical MCP URL and setup instructions. `/cms/health` reports database and sign-in readiness without exposing secrets. `/cms/status` is authenticated and drives preview refresh. Optional `documentUrl(path)` maps agent edits to site routes for pinned before/after review links.

Publication rejects unresolved references and unsubmitted edits, then creates a membership checkpoint to bound ancestry traversal. The audit log is atomic with content mutations. Restoring a document appends a new revision; it does not erase the old one. Automatic GitHub synchronization and automatic content garbage collection are not provided.

## Updating agent branches with Git

Agents call `get_draft_update`, inspect conflicts with `read_merge_conflict`, then call `update_draft`. Each plan is bound to an authorized draft, its base, and the observed draft/published heads. Identical retries reuse the saved result; different resolutions require a new command key. Git handles content merges and renames. Conflicts support keeping the entire draft or published file, supplying resolved source, or deleting a file.

The update transaction guards both heads and saves the new draft ref, base metadata, audit event, and Git commit mapping together. It never publishes. Previous review decisions remain attached to the old snapshot. The review UI offers the same Git update and resolution flow and submits the result for fresh approval.

Native Git must be available to this runtime. The docs deployment bundles Git and its Linux loader/libraries from the build image, with traced assets verified through `/cms/health`. Durable Git packs and plans live in dedicated database tables. No GitHub content repository or persistent filesystem is required.

## Media and unmodeled files

MCP exposes `list_files`, `read_file`, and `write_asset` (canonical base64, up to 512 KiB). Source tools also accept text files outside collection schemas. Asset writes retain draft authorization, expected revisions, audit events, and idempotent retries; `write_asset` cannot bypass a document schema.

The toolbar links to `/cms/media-library`. Select a draft to upload files up to 4 MiB with the browser. `/cms/media?path=...&snapshot=...` serves only the active authorized view; a supplied snapshot must match it. `/cms/review/media` checks review access and the exact revision before returning a file version. Media responses support byte ranges, disable shared caching, and never redirect to public blob URLs. Recognized raster images, audio, and video render in comparisons; SVG/HTML and unknown formats are sandboxed downloads. Symlinks are never served.

The host renders Markdown images using the same snapshot context as its document. See the docs app for an example mapping `/media/example.png` to the authorized media endpoint.
