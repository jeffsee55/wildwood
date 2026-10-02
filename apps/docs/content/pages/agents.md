---
title: "Connect your agent"
description: "Discover the model, edit a draft, and return a reviewable result through MCP."
order: 15
author: /content/authors/team.md
---

Wildwood exposes a remote MCP server at `/cms/mcp`. Open [connection setup](/cms/connect), copy the URL, and add it to an OAuth-capable agent. Sign in when prompted and choose the permissions that connection needs.

## A complete task

Try asking: “Discover this site's content model. Create a draft, improve the introduction, validate the changes, and give me a preview and a review link.”

The agent starts with `discover_content`. It learns collection names, required fields, references, locale options, and file patterns. It can search with `read_documents`, inspect exact Markdown with `read_source`, and follow author references with `resolve_reference`.

## Editing safely

`create_draft` starts from the published site. Give the draft a readable name. `update_document` changes top-level fields while preserving body text unless the body is included. `apply_changes` saves a batch of writes and deletions atomically; use it for related edits or renames. `validate_changes` checks schemas without saving.

Every save uses the revision last observed and a unique command key. If the connection drops, retry the identical operation with that same key. If another editor has advanced the draft, read the new version and reconcile before sending a new command.

For large collections, `read_documents` returns a snapshot and `nextOffset`. Pass that snapshot on the next page; the server rejects pagination across an intervening edit. Bodies are omitted by default to keep results compact.

## Preview, review, recover

`create_preview` returns a pinned link with an expiry. `get_draft_changes` shows the file list. `submit_review` returns a durable review URL; `get_review` returns feedback the agent can act on.

`get_history` records who changed which files and when. `restore_document` brings an earlier version back as a new draft edit. It never erases history or changes the published site directly.

The connection is limited to its authorized drafts. Editing credentials cannot approve or publish. You can revoke the connection in **Manage access**.
