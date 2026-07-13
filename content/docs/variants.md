---
title: Variants
author: ../authors/jeff.md
description: "Locale/version-like axes, path modifiers, resolution order, and scoring for matching entries to variants."
---

# Variants

Variants model orthogonal axes like locale and release version. A file may exist in `en` only, `fr.v2` only, or both. tr33 lets you declare the axes and `findMany({ variant: "locale:fr|version:v2" })` to pick the closest available file for each path.

## Declaration

```ts
const config = defineConfig({
  variants: {
    locale: {
      options: ["en", "fr"],
      default: "en",
      pathModifier: { type: "extensionPrefix" }, // e.g. intro.fr.md
    },
    version: {
      options: ["v1", "v2"],
      default: "v1",
      pathModifier: { type: "folder" }, // e.g. fr/intro.md
    },
  },
  collections, org, repo, ref, version: "2",
});
```

`defineConfig` input type: `Record<string, VariantConfig>` where `VariantConfig = { options: string[]; default?: string; pathModifier?: { type:"extensionPrefix" | "folder" } }`.

- `options` — allowed values for this axis. Order does not affect scoring except as tie-breaker (first declared variant wins when match count ties).
- `default` — default option. Optional; when omitted, `options[0]` is treated as default for scoring insertion.
- `pathModifier` — how the variant manifests in the file path.

Zod validation: `variantsConfigSchema`, `configInputSchema` (output has `version` defaulted to `"0"` if omitted).

## Path modifiers

- `extensionPrefix`: `"doc.fr.md"` matches `option="fr"`. Detection via `path.includes(`${.${option}.`)` and `canonical = path.replace(`${}.${option}.`, ".")`. Dimensionality: strips extension prefix to canonical.
- `folder`: `"fr/doc.md"` matches `option="fr"`. Detection via `path.startsWith(\`${option}/\`)`and`canonical = path.slice(option.length+1)`.
- (Absence): variant affects only logical `variant` string in the index, not the path. File may still carry explicit axis in name if you handle it yourself, but tr33 won't parse it without a `pathModifier`.

Multiple modifiers in one path are handled in declaration order: for each variant axis, scan its options, call `matchPathToVariantOption(canonical, axis, option)`, on match collapse to canonical and push explicit key. So `en.fr.v2.md` with `extensionPrefix` for locale+version could normalize to `en.md` → key `fr, v2`? Actually iteration order matters — which is why earlier axes in declaration win the tie-breaker.

## Resolution

Given `{ ref, variant = config.defaultVariant() }`:

- `config.defaultVariant()` from axes `entries.map(key -> ${key}:${default})` (default = `cfg.default ?? options[0]`). Empty → `"__"`.
- `parseVariantCombo(combo)` → map of axis→option; when `"__"` → empty map.
- For missing axes (requested map doesn't have axis), fill with default (`cfg.default ?? options[0]`). So all axes always have a requested value before scoring.
- `getPathVariantInfo(path)` returns `{ canonical, options, explicitKeys }` built via `pathModifier` scan above (only if axis has modifier). For axes without modifier, `options` is empty and `explicitKeys` empty unless you have some other naming (treated as `default` later).
- `findMostSpecificVariant(entries, variant)`):
  - Convert `entries` list (strings: paths matching a canonical) into `{ path, canonical, options, explicitKeys }` where for each axis missing from `info.options` fill with default (`cfg.default ?? options[0]`) — so a default path like `"a.md"` becomes `{ locale:"en", version:"v1" }` logically.
  - Filter to _allowed_: entries whose every explicit axis matches the requested value. Default paths (`explicitKeys=[]`) always allowed. E.g. `b.fr.v2.md` allowed for `locale:fr|version:v2` but not for `locale:en|...` because `locale:fr != requested en`. Never fall back to an explicit-conflicting path.
  - If allowed empty → undefined.
  - Score allowed entries:
    1. `countMatch(e)` — how many axes have `e.options[k] === requested[k]` (after filling missing axes with default). Highest wins.
    2. `countExplicitMatch` — how many axes are both explicit and match requested. Highest wins (prefer more explicit).
    3. Tie-break: first axis in declaration order where `a` explicit-matches and `b` doesn't (or vice versa) wins. Same as scoring note in class doc.
  - Return `scored[0].path`.

Callers: `Config.index` calls `findMostSpecificVariant`? Actually indexer calls `visitor` then `processVariant` per axis for each file? Variant selection is mostly reader-side; entries are stored per file path with its `variant` column from `getPathVariantInfo` + default fallthrough. At query time, `findMany({ variant })` call resolves `findMostSpecificVariant(connectionPaths[], requestedVariant)` for multi-path semantics (e.g. localizables in page collection). For single-path collection? Your query still drives read using `variant` string; the outer filter is against `entries.variant` col? Exact filtering logic in `query-builder.ts` — here doc is concept.

## findMissingCombos and listVariants

- `listVariants()` → all combinations `options` cross product: start `[""]`, for each axis flatMap(prevCombo × each axis option) yielding `"locale:en|version:v1"` style strings. Empty when no variants → `["__"]`.
- `findMissingCombos(entries)` → for each `listVariants()` combo, call `findMostSpecificVariant(entries, thatVariant)` and return `{ variant, path: best ?? "" }`. Used for editor to show which locale/version combos are missing for a given logical path.

## Examples

With `locale {en,fr} ext-prefix, version {v1,v2} folder`:

- Files: `intro.md`, `intro.fr.md`, `v2/intro.md`, `v2/intro.fr.md`, `fr/intro.v2.md` (folder variant out of order but still matched by scan order).
- Query `locale:en|version:v1`: picks `intro.md` (default path, always allowed) unless you have explicit `en.v1` etc.
- Query `locale:fr|version:v2`: allowed candidates are `intro.fr.v2.md`, `intro.fr.md`? `intro.fr.md` allowed because `locale:fr` explicit matches `fr`, version implicit would default to `v1` which does not match `v2`? Wait explicit check: `intro.fr.md` has `explicitKeys=[locale]`, `locale:fr===requested:fr`, so passes allowed filter (version axis absent in explicitKeys → not checked for mismatch). Then `countMatch` gives version implicit `v1` vs requested `v2` -> `locale` matches, version mismatch (1 match), `countExplicitMatch=1` (only `locale`). `intro.fr.v2.md` has explicit keys both `locale:fr`,`version:v2` (2 explicit matches). So `fr.v2` wins over `fr` as expected — more explicit matches. So `findMostSpecificVariant` prefers the most specific explicit shadowing.

- Querying canonical-less behavior: call `findMany({ variant:"locale:fr" })` even when some paths have no extensionPrefix folder path etc — they'd resolve after fill with defaults to `fr` or explicit mismatch.

## Sorting / tie-break

Tie-break order defined by `variantKeys = Object.keys(variants)` in declaration order. First key wins when equal scoring — documented reason: if you declare `locale,version`, and request `locale:en|version:v2`, and there are files `a.en.md` and `a.v2.md`, `a.en.md` wins (first match on `locale`). Don't rely on folder nesting order; if you care about strict precedence declare the primary axis first.

## Where variants are stored

`entries` row has `variant` string (canonical-inferred logical axis value for this file, per `getPathVariantInfo`), `canonical` string (base path without variant modifiers), `collection`, `slug`, `oid`. So `Config.buildEntry` appends system fields `slug/path/canonicalPath` (via `deriveSlug`/`createEntryRules`) + frontmatter.

Read more: `Config.defaultVariant`, `findMostSpecificVariant`, `getPathVariantInfo`, `matchPathToVariantOption`, `parseVariantCombo`, `listVariants`, `findMissingCombos` in `client/config.ts`.

Next: [Branching](./branching.md) and [Deploy](./deploy.md).
