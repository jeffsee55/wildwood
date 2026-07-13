# Critique: Extension fetching and tree/blob handling

Context: lazy tree fetching, stale-tolerant data, cacheable blob/tree (cache headers TBD).

---

## What’s working well

- **Lazy tree loading**: Single-tree fetch (`/tree/:oid`) and store-on-miss keeps work minimal per path.
- **Single source of worktree state**: `worktrees/:ref` replaces rev-parse and gives base + changes in one call; no duplicate “get ref” endpoints.
- **Apply-dirty is local**: `applyDirtyEntriesToTree` uses the in-memory store and only pulls trees it needs via `getTree`; no extra “give me full dirty tree” API.
- **Full-tree is optional**: `triggerFullTreeFetch()` is fire-and-forget and only fills the store; correctness doesn’t depend on it.
- **Immutable OIDs**: Trees and blobs keyed by OID are a good fit for future cache headers (e.g. long-lived or immutable cache for `/tree/:oid`, `/blob/:oid`).

---

## 1. Full-tree vs current ref and dirty state

**Behavior**: `triggerFullTreeFetch()` calls `/full-tree/${this.ref}`. On the server, that does `remote.fetch(ref)` then `fetchFullTree(commit.treeOid, git.treeStore)` and returns the server’s store. So the client gets the **base** tree for the ref, not the tree that includes the extension’s **dirty** entries.

**Impact**: For “lazy + cacheable” this is fine: you’re prefilling tree OIDs that are likely needed (base tree). Trees created by `applyDirtyEntriesToTree` (new root, new intermediate nodes) are not in that response and will be fetched on demand via `/tree/:oid` when the store misses. So no correctness bug, but worth being explicit: full-tree is “hint for base tree,” not “full current worktree.”

**Suggestion**: A short comment in `triggerFullTreeFetch()` that full-tree is for the base commit only; dirty-applied trees are still fetched lazily.

---

## 2. worktrees/base is never refreshed

**Behavior**: `ensureBaseTree()` runs once and then no-ops (`if (this.baseTreeOid !== null) return`). So `baseTreeOid` and `serverChanges` are fixed for the session.

**Impact**: If the user switches branch (or someone else pushes and the server’s worktree state changes), the extension keeps using the old base and old server changes until reload. You said you’re okay with stale data and that trees are mostly immutable, so this may be acceptable.

**Suggestion**: If you ever support “switch ref” in the same provider instance, you’ll need a way to clear `baseTreeOid` (and possibly `serverChanges`, `rootTreeOid`) so the next `ensureRootTree()` re-fetches worktrees. For now, documenting “worktree state is per-session and not refreshed” is enough.

---

## 3. Blobs: no local cache, every read hits the network

**Behavior**: `fetchBlob(oid)` always does `fetch(.../blob/${oid})` and returns; there’s no in-memory (or other) blob cache in the provider.

**Impact**: Re-reading the same file (e.g. switching tabs, or multiple `readFile`/`getEntry` for the same blob) causes repeated blob fetches. That conflicts a bit with “blob fetching is very cacheable.”

**Suggestions** (when you add caching):

- **Client**: In-memory `Map<oid, BlobEntry>` (or similar) keyed by OID. Same “don’t overwrite if already present” rule as trees if you ever have multiple refs. Invalidation is optional if you treat blobs as immutable.
- **Server**: You already have `db.blobs.batchGet` before remote; once you add cache headers, ensure `/blob/:oid` sets something like `Cache-Control: public, max-age=..., immutable` for OID-based URLs so the browser (and any CDN) can cache.

---

## 4. Redundant work in applyDirtyEntriesToTree when many dirty files share the same path prefix

**Behavior**: For each dirty entry you walk root → leaf, then walk back up and update ancestors. Multiple files under the same directory cause the same ancestor trees to be loaded and then updated multiple times (once per file under that dir).

**Impact**: More tree fetches and more `calculateTreeOid` / store writes than strictly necessary. For a few dirty files this is negligible; for many files in the same tree it could be optimized.

**Suggestion**: Low priority. If you ever optimize, you could group dirty entries by common path prefix and update each ancestor tree once per group (e.g. collect all dirty under `content/docs`, update that subtree once). Not needed for “lazy + cacheable” until you see real load.

---

## 5. full-tree and worktrees ref mismatch (theoretical)

**Behavior**: Extension is built with a single `ref` (e.g. from `extensionUri` query). `ensureBaseTree()` uses `this.ref`; `triggerFullTreeFetch()` uses `this.ref`. So both use the same ref.

**Impact**: If in the future the provider could switch ref (e.g. branch switcher), you’d want full-tree to use the same ref as the current worktree. Right now there’s no ref switch, so no bug.

**Suggestion**: None for current design. If you add ref switching, ensure full-tree (and any other ref-scoped fetch) uses the “current” ref that matches `baseTreeOid` / `serverChanges`.

---

## 6. Error handling and retries

**Behavior**: Failed fetches (worktrees, tree, blob) throw or return errors; there are no retries or backoff. Full-tree failure is only logged and the promise is left rejected (caller doesn’t await it).

**Impact**: Transient network errors immediately surface to the user. For “cacheable and tolerant of staleness,” a single retry (or “retry once after 500”) could improve UX without complicating the model.

**Suggestion**: Optional: add a small retry (e.g. one retry after 1s) for `ensureBaseTree()` and `fetchTreeFromApi`/`fetchBlob` so one-off flakes don’t always show as hard errors. Keep full-tree as best-effort (no retry needed).

---

## 7. readDirectory and dirtyFiles vs applied tree

**Behavior**: After `applyDirtyEntriesToTree`, the effective root tree already includes dirty files. You still merge in `dirtyFiles` again in `readDirectory`: “Add dirty files that are in this directory” and “if (!entry.entries[relativePath])”.

**Impact**: Correct: the applied tree has the file, so `entry.entries[relativePath]` is usually set and you don’t double-add. The loop only adds when the file is not in the tree (e.g. new file in a new directory that wasn’t in the base tree). So no double-listing, but the logic is a bit redundant with the applied tree.

**Suggestion**: Keep as-is for safety (covers any edge case where the applied tree might not have the entry). Optionally add a one-line comment: “Include dirty files not yet present in tree (e.g. new dirs).”

---

## 8. Server: full-tree mutates server’s global treeStore

**Behavior**: `GET /full-tree/:ref` does `remote.fetchFullTree(commit.commit.treeOid, git.treeStore)` and returns `Object.fromEntries(git.treeStore)`. So the server’s shared `git.treeStore` is mutated and then serialized to JSON.

**Impact**: If the server handles multiple refs or concurrent requests, one full-tree request can overwrite or mix tree state for another ref. For a single-tenant/single-ref setup this may be fine. Also, the response is “current contents of the store,” which might include trees from previous requests.

**Suggestion**: For multi-tenant or multi-ref, consider either (a) a short-lived store per full-tree request and return that, or (b) documenting that full-tree is best-effort and ref-specific and that the server’s store is shared. For cache headers, returning a ref-scoped or commit-scoped URL (or Vary) could help; OID-based `/tree/:oid` is already safe to cache.

---

## 9. Summary table

| Area                       | Priority    | Note                                                              |
| -------------------------- | ----------- | ----------------------------------------------------------------- |
| full-tree = base only      | Doc         | Comment that dirty trees are still lazy-loaded.                   |
| worktrees never refreshed  | Doc / later | Document per-session; add refresh if you support ref switch.      |
| Blob cache                 | Later       | Add in-memory (and then HTTP cache headers) when you add caching. |
| applyDirty batching        | Low         | Only if many dirty files under same dir.                          |
| Retries                    | Optional    | One retry for worktrees/tree/blob can reduce flakiness.           |
| readDirectory + dirtyFiles | Optional    | Comment that it’s a safety net for applied tree.                  |
| Server full-tree store     | Later       | Per-request or documented shared store if multi-ref.              |

Overall the design matches the goals: lazy tree loading, stale-tolerant semantics, and a path to cacheable blob/tree once you add headers and an optional blob cache on the client.
