---
title: "Schema generations"
description: "Prepare new interpretations without rewriting source history."
order: 40
author: /content/authors/team.md
---

## Bump the version

A generation identifies how source bytes are parsed and indexed. This demo's generation 2 adds an `audience` field with a safe default. Existing Markdown does not need that field.

Switch between generation 1 and 2 above. Both read the same snapshot. The second generation prepares its own projections automatically; the first remains available.

## Defaults are not arbitrary migrations

A version bump cannot invent missing required information. Invalid content fails preparation and does not move a branch. Supply a default, a deterministic transformation, or update the source data when the schema requires it.
