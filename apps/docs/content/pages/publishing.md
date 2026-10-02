---
title: "Review and publish"
description: "Approve an exact snapshot and make it live without rebuilding the website."
order: 25
author: /content/authors/team.md
---

Drafts isolate work from the published website. The review workspace brings source diffs, discussion, and pinned before/after previews together.

## Approve what you saw

Submit a draft for review, inspect the changes, and approve that revision. Editing after submission requires a new review revision. Old approvals cannot authorize new content, and unresolved requests for changes block publication.

Publication also verifies content references in every configured locale combination. Deleting an author that a page still references is allowed while drafting, but must be repaired before publishing.

## Make it live

An owner publishes the exact approved snapshot. The live ref must still match the draft's original base; if another draft was published first, the operation reports a conflict instead of overwriting it.

This site reads the live ref on every server request and caches document results by immutable snapshot. A successful publication is visible without a Vercel rebuild. Open draft views return to published content once the draft is completed.

## Interrupted publication

The operation reserves the review durably before moving the live ref. If a network failure makes the result uncertain, repeat the same publication operation to reconcile it. The system records one result and preserves the completed draft as read-only history.

Owners can also issue a short-lived publication credential pinned to one approved review revision. Its MCP tools can inspect and publish only that revision; they cannot edit, approve, or delegate access.

## Durable storage

The remote database and blob store hold authoritative content and review history. Back them up together. Git import/export is available as an optional adapter; automatic GitHub synchronization is not configured by this site.
