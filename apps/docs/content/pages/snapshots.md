---
title: "Branches and snapshots"
description: "A branch is a pointer, not a duplicate content collection."
order: 20
author: /content/authors/team.md
---

## One edit, one change

Creating a branch adds a ref pointing to an existing snapshot. Editing one file writes its bytes, a new snapshot, and a change entry. Unchanged files come from the immutable ancestry. Deletes are tombstones.

## Correct queries

The query first resolves effective membership and variant precedence. It then filters, sorts, and paginates that result. A shadowed base file cannot reappear because it happens to match a filter.

References resolve inside that same snapshot. Changing an author can change a reference filter without rewriting every article.

## The current cost

Sparse history avoids duplicating all files on each edit. Preparation still scans effective files, and ancestry queries are not a constant-time solution for millions of files. Checkpoints can accelerate membership at the cost of a materialized file list.
