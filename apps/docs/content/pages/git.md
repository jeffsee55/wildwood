---
title: "Git branches and merges"
description: "Real Git merges, with agent branches and history stored in the database."
order: 50
author: /content/authors/team.md
---

## One branch per agent

Each agent edits its own draft branch. The database holds branch pointers, immutable content snapshots, and Git history packs. Git runs in a temporary repository when a merge is needed; that directory can be discarded afterward.

## Updating a draft

When another branch publishes first, ask your agent to call `get_draft_update`. Native Git compares the branches and combines compatible changes, including separate edits within a file and detected renames. The plan is pinned to both branch heads.

If there are conflicts, `read_merge_conflict` returns the original, draft, published, and Git conflict-marker versions. Resolve each path using the draft version (`ours`), the published version (`theirs`), custom text, or deletion. A whole-file choice also chooses deletion when that side has no file. Review Git's conflict messages, then call `update_draft` with the plan and a unique command key.

A changed branch invalidates the plan. Request a fresh plan instead of silently overwriting newer work. An interrupted save can be retried with the identical command key and resolutions.

## Review again

Updating a draft does not publish it or reuse its previous approval. Validate the merged content and submit a fresh review. The review page also provides **Update draft with Git**, comparisons, and conflict-resolution controls.

The merged content, branch base, audit event, and Git commit mapping are saved in one database transaction. Git commits retain both parents. Shared previews and old reviews keep their original snapshots.

## Import and export

The optional native Git adapter imports committed trees and exports exact file bytes, modes, and preserved history. Its experimental Git HTTP handler supports authenticated clone/fetch on a persistent Node host; push ingestion is not implemented. The docs site bundles native Git for temporary merge computation on Vercel and does not host a Git remote.
