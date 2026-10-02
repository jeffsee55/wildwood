---
title: "Variants with fallback"
description: "Choose a language without copying an entire branch."
order: 30
author: /content/authors/team.md
---

## Files express differences

`introduction.fr.md` overrides `introduction.md` for French. A page without a French file uses its base content. Variant selection happens before filters and reference traversal.

The language switch here selects the locale axis. The author also has a French variant, so the byline changes even when the page itself falls back to English.

A branch and a variant are independent: edit a French page in your draft and neither the English page nor the published French page changes.
