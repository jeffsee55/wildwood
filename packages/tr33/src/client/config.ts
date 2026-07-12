import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod/v4";
import type { Cache, Entry, Namespace } from "@/types";
import { zodVisitor } from "@/zod/visitor";

/**
 * Walk up from `start` until we find a `.git` marker. Returns the git root
 * or null. Used when `localPath` is omitted for zero-config dev.
 */
export function resolveLocalGitRoot(start = process.cwd()): string | null {
  const override =
    process.env.TR33_DOCS_REPO_PATH?.trim() ||
    process.env.TR33_PLAYGROUND_LOCAL_ROOT?.trim() ||
    "";
  if (override) {
    const abs = isAbsolute(override) ? normalize(override) : resolve(start, override);
    return existsSync(abs) ? abs : null;
  }

  let dir = start;
  for (let depth = 0; depth < 12; depth++) {
    try {
      if (existsSync(join(dir, ".git"))) return dir;
    } catch {
      // ignore
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Normalize a user-supplied `localPath`: relative -> cwd-absolute, or pass through absolute. */
export function normalizeLocalPath(p: string, cwd = process.cwd()): string {
  const t = p.trim();
  if (!t) return t;
  return isAbsolute(t) ? normalize(t) : resolve(cwd, t);
}

function shouldAutoUseLocal(): boolean {
  // In production (Vercel etc) there is no checkout — don't auto-select native.
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    return false;
  }
  if (process.env.TR33_DOCS_SOURCE === "github") return false;
  if (process.env.TR33_DOCS_SOURCE === "local") return true;
  // Dev / build prefetch: auto-use local if we can find a git root.
  return true;
}

export function fixedPrefixFromMatch(match: string): string {
  const normalized = match.replace(/\\/g, "/");
  const segs = normalized.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (/[*?[\]{}()!+]/.test(s)) break;
    if (!s) continue;
    out.push(s);
  }
  return out.join("/");
}

export function deriveSlug(
  filePath: string,
  opts: { basePath?: string; match: string },
): string {
  let p = filePath.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
  const base = (opts.basePath != null ? opts.basePath : fixedPrefixFromMatch(opts.match))
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^\.?\//, "");
  if (base && (p === base || p.startsWith(base + "/"))) {
    p = p === base ? "" : p.slice(base.length + 1);
  }
  p = p.replace(/\.[^/]+$/, "");
  p = p === "index" ? "" : p.replace(/\/index$/, "");
  return p;
}

/**
 * Runtime validation still uses a loose schema. The TS type for collections
 * is intentionally broad (`schema: $ZodType`) so that `defineConfig` can
 * capture the literal schema shape via `T extends ConfigInput`. If we typed
 * `Collection["schema"]` as `ZodCodec<ZodString, ZodObject>` (or via
 * `z.infer<typeof collectionSchema>`), we erase the inner frontmatter shape and
 * lose `FindTypes` information for `with`/`where` join inference, especially
 * after `dist` `.d.ts` emit (where `_zod.def.shape` widens to `LooseShape`).
 */
export const collectionSchema = z.object({
  name: z.string(),
  match: z.string(),
  basePath: z.string().optional(),
  schema: z.custom<z.core.$ZodType>(),
});

// TS-level collection – schema is any Zod type so literals are preserved via `T`.
export type Collection = {
  name: string;
  match: string;
  basePath?: string;
  schema: z.core.$ZodType;
};

/**
 * Variants allow for multiple reprentations of your content
 * They can either be inlined at the field-level, or file-based.
 * There is always a default, which will be used in the absence
 * of a matching variant. And matching is hierarchial, based
 * on the order of the variants declared.
 *
 * If you have a locale and version variant. And  have v1, v2
 * and en and fr locales. You might be missing a v1 french
 * page, but becuase you declared locales first, the fr locale
 * will be used, instead of the v2 version
 *
 * Optionally, you can enforce that a variant is always
 * provided either at the file level, or anywhere that a field
 * variant is declared (not implemented yet)
 */
export const variantsConfigSchema = z.object({
  options: z.array(z.string()),
  // Default option does not need to match the path
  // modifier. It can, but it's optional
  default: z.string().optional(),
  pathModifier: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("extensionPrefix") }),
      z.object({ type: z.literal("folder") }),
    ])
    .optional(),
});
// export const variantsSchema = z.record(z.string(), variantsConfigSchema);

export const configInputSchema = z.object({
  org: z.string(),
  repo: z.string(),
  ref: z.string(),
  localPath: z.string().optional(),
  version: z.string().optional(),
  collections: z.record(z.string(), collectionSchema),
  variants: z.record(z.string(), variantsConfigSchema).optional(),
});

export const configOutputSchema = z.object({
  org: z.string(),
  repo: z.string(),
  ref: z.string(),
  localPath: z.string().optional(),
  version: z.string(),
  variants: z.record(z.string(), variantsConfigSchema).optional(),
  collections: z.record(z.string(), collectionSchema),
});

export const configSchema = z.codec(configInputSchema, configOutputSchema, {
  decode: (value) => {
    return {
      ...value,
      version: value.version ?? "0",
    };
  },
  encode: (value) => {
    return value;
  },
});

export class Config<Colls extends AnyCollections = AnyCollections> {
  configObject: ConfigObject;
  configInput: DefineConfigInput<Colls>;
  /** Auto-detected git root when `localPath` was omitted and we're in dev/build. */
  private _autoLocalPath: string | null | undefined = undefined;

  constructor(config: DefineConfigInput<Colls>) {
    // store as generic to preserve literal shapes
    this.configInput = config as unknown as DefineConfigInput<Colls>;
    // runtime validation: safe because schema is loose
    const parsed = configSchema.decode(config as unknown as z.infer<typeof configInputSchema>);
    this.configObject = parsed as unknown as ConfigObject;
  }

  get org() {
    return this.configObject.org;
  }
  get repo() {
    return this.configObject.repo;
  }
  get ref() {
    return this.configObject.ref;
  }
  /** Explicit `localPath` from `defineConfig` (may be undefined). */
  get localPath(): string | undefined {
    return this.configObject.localPath;
  }

  /**
   * Resolved local git root:
   * - explicit `localPath` wins,
   * - else in dev/build prefetch, auto-detect by walking up from cwd to `.git`,
   * - else undefined (=> GitHubRemote / prod DB-only).
   *
   * This is what `createClient` and `NativeRemote` should use for decisions,
   * not the raw `localPath`.
   */
  get resolvedLocalPath(): string | undefined {
    if (this.configObject.localPath) return this.configObject.localPath;
    if (this._autoLocalPath !== undefined) return this._autoLocalPath ?? undefined;
    if (!shouldAutoUseLocal()) {
      this._autoLocalPath = null;
      return undefined;
    }
    const found = resolveLocalGitRoot(process.cwd());
    this._autoLocalPath = found;
    return found ?? undefined;
  }

  /** Whether this config wants a native git checkout (explicit or auto-detected). */
  get wantsLocal(): boolean {
    return this.resolvedLocalPath !== undefined;
  }

  get version() {
    return this.configObject.version;
  }
  get collections() {
    return Object.values(this.configObject.collections);
  }

  defaultVariant() {
    const variants = this.configObject.variants;
    if (!variants || Object.keys(variants).length === 0) {
      return "__";
    }
    // Build default variant combo from each variant's default option
    const defaults: string[] = [];
    for (const [key, variantConfig] of Object.entries(variants)) {
      const defaultOption = variantConfig.default ?? variantConfig.options[0];
      defaults.push(`${key}:${defaultOption}`);
    }
    return defaults.join("|");
  }

  get namespace(): Namespace {
    return {
      orgName: this.org,
      repoName: this.repo,
      // ref: this.ref,
      version: this.version,
    };
  }
  matches(path: string) {
    const collections = Object.values(this.configObject.collections);
    return collections.some((collection) => {
      return minimatch(path, collection.match);
    });
  }
  getCollectionForPath(path: string) {
    let collectionName: string | null = null;
    for (const [key, collection] of Object.entries(
      this.configObject.collections,
    )) {
      if (minimatch(path, collection.match)) {
        collectionName = key;
        break;
      }
    }
    return collectionName;
  }
  get paths() {
    const collections = Object.values(this.configObject.collections);
    const deepestFixedFolders = collections.map((collection) => {
      const segments = collection.match
        .replace(/\\/g, "/")
        .split("/")
        .map((segment) => {
          if (/[*?[\]{}!]/.test(segment)) return null;
          return segment;
        })
        .filter((segment) => segment !== null);

      return segments.length > 0 ? segments.join("/") : "";
    });

    // Remove overlapping paths - if we have 'docs' and 'docs/pages',
    // we only need 'docs' since it includes everything

    if (deepestFixedFolders.length <= 1) {
      return deepestFixedFolders;
    }

    const sortedPaths = [...deepestFixedFolders].sort(
      (a, b) => a.length - b.length,
    );
    const result: string[] = [];

    for (const currentPath of sortedPaths) {
      const isNested = result.some((existingPath) => {
        // Root ("" or "/") contains all paths
        if (existingPath === "" || existingPath === "/") return true;
        return currentPath.startsWith(`${existingPath}/`);
      });
      if (!isNested) {
        result.push(currentPath);
      }
    }
    return result;
  }

  maybeBuildCollectionForPath(path: string) {
    try {
      return this.buildCollectionForPath(path);
    } catch {
      return null;
    }
  }

  slugForPath(filePath: string, collectionName?: string): string {
    const name = collectionName ?? this.getCollectionForPath(filePath);
    let match = "**/*";
    let basePath: string | undefined;
    if (name) {
      const col = this.configObject.collections[name] as
        | { match: string; basePath?: string }
        | undefined;
      if (col) {
        match = col.match;
        basePath = col.basePath;
      }
    }
    return deriveSlug(filePath, { basePath, match });
  }

  /**
	 *
	 *   'locale:en|version:v1',
				'locale:en|version:v2',
				'locale:en|version:v3',
				'locale:fr|version:v1',
				'locale:fr|version:v2',
				'locale:fr|version:v3'

				with an array of
				[ 'b.md', 'b.fr.v2.md', 'b.fr.md' ]
				 or 
				 [ 'a.v1.md', 'a.md' ]
	 */
  findMostSpecificVariant(
    entries: string[],
    variant: string,
  ): string | undefined {
    const variants = this.configObject.variants;
    if (!variants || Object.keys(variants).length === 0) {
      return entries[0];
    }
    if (entries.length === 0) return undefined;

    const variantKeys = Object.keys(variants);
    const requested = this.parseVariantCombo(variant);

    // Fill requested with defaults for any missing keys
    for (const key of variantKeys) {
      if (!(key in requested)) {
        const cfg = variants[key];
        requested[key] = cfg?.default ?? cfg?.options?.[0] ?? "";
      }
    }

    const entriesWithInfo = entries.map((path) => {
      const info = this.getPathVariantInfo(path);
      // Fill options with default for keys not in path
      for (const key of variantKeys) {
        if (!(key in info.options)) {
          const cfg = variants[key];
          info.options[key] = cfg?.default ?? cfg?.options?.[0] ?? "";
        }
      }
      return { path, ...info };
    });

    // Only allow (1) default/base path (no explicit variant keys), or (2) path whose explicit dimensions all match (no conflicting variant).
    // Never fall back to a path that has an explicit variant that doesn't match (e.g. b.fr.v2.md for locale:en|version:v2).
    const allowed = entriesWithInfo.filter((e) => {
      if (e.explicitKeys.length === 0) return true; // default path can serve any variant
      for (const key of e.explicitKeys) {
        if (e.options[key] !== requested[key]) return false;
      }
      return true;
    });
    if (allowed.length === 0) return undefined;

    // Score allowed entries by closest match: most matching dimensions first, then by variant key order (first key match wins tie)
    const scored = allowed.slice().sort((a, b) => {
      // Count matching dimensions (exact or default)
      const countMatch = (e: (typeof entriesWithInfo)[0]) =>
        variantKeys.filter((k) => e.options[k] === requested[k]).length;
      const aMatch = countMatch(a);
      const bMatch = countMatch(b);
      if (bMatch !== aMatch) return bMatch - aMatch;
      // Tie-break: prefer most explicit matching dimensions
      const countExplicitMatch = (e: (typeof entriesWithInfo)[0]) =>
        e.explicitKeys.filter((k) => requested[k] === e.options[k]).length;
      const aExplicit = countExplicitMatch(a);
      const bExplicit = countExplicitMatch(b);
      if (bExplicit !== aExplicit) return bExplicit - aExplicit;
      // Tie-break: prefer match on earlier variant key
      for (const key of variantKeys) {
        const aExplicitKey =
          a.explicitKeys.includes(key) && a.options[key] === requested[key];
        const bExplicitKey =
          b.explicitKeys.includes(key) && b.options[key] === requested[key];
        if (aExplicitKey && !bExplicitKey) return -1;
        if (!aExplicitKey && bExplicitKey) return 1;
      }
      return 0;
    });

    return scored[0].path;
  }

  /** Returns the full set of listVariants(), each with the path that is the closest match (fallback). Only direct match or default path; no match yields "". */
  findMissingCombos(entries: string[]): { variant: string; path: string }[] {
    return this.listVariants().map((variant) => {
      const path = this.findMostSpecificVariant(entries, variant);
      return { variant, path: path ?? "" };
    });
  }

  listVariants() {
    const variantEntries = Object.entries(this.configObject.variants || {});
    if (variantEntries.length === 0) {
      return ["__"];
    }
    // Build arrays of options for each variant key
    const variantOptions = variantEntries.map(([key, variant]) =>
      variant.options.map((option) => `${key}:${option}`),
    );
    // Reduce to get all combinations
    return variantOptions.reduce<string[]>(
      (combinations, options) =>
        combinations.flatMap((combo) =>
          options.map((opt) => (combo ? `${combo}|${opt}` : opt)),
        ),
      [""],
    );
  }

  buildCollectionForPath(path: string) {
    const name = this.getCollectionForPath(path);
    if (!name) {
      throw new Error(`No collection found for path ${path}`);
    }
    const schema = this.configObject.collections[name];
    if (!schema) {
      throw new Error(`Collection ${name} not found`);
    }
    return { name, schema };
  }

  /**
   * Extract canonical path and variant options from a path.
   * e.g. "a.fr.v1.md" with locale (en,fr) and version (v1,v2,v3) => { canonical: "a.md", options: { locale: "fr", version: "v1" }, explicitKeys: ["locale", "version"] }
   */
  private getPathVariantInfo(path: string): {
    canonical: string;
    options: Record<string, string>;
    explicitKeys: string[];
  } {
    const variants = this.configObject.variants;
    const options: Record<string, string> = {};
    const explicitKeys: string[] = [];
    let canonical = path;

    if (variants) {
      for (const [variantKey, variantConfig] of Object.entries(variants)) {
        if (!variantConfig.pathModifier) continue;
        let matched = false;
        for (const option of variantConfig.options) {
          const result = this.matchPathToVariantOption(
            canonical,
            variantKey,
            option,
          );
          if (result) {
            options[variantKey] = option;
            explicitKeys.push(variantKey);
            canonical = result;
            matched = true;
            break;
          }
        }
        if (!matched && variantConfig.default !== undefined) {
          options[variantKey] = variantConfig.default;
        }
      }
    }

    return { canonical, options, explicitKeys };
  }

  /**
   * Check if a path matches a specific variant option based on pathModifier
   * Returns the canonical path (with variant modifier stripped) if matched, null otherwise
   */
  private matchPathToVariantOption(
    path: string,
    variantKey: string,
    option: string,
  ): string | null {
    const variantConfig = this.configObject.variants?.[variantKey];
    if (!variantConfig?.pathModifier) return null;

    const { type } = variantConfig.pathModifier;
    if (type === "extensionPrefix") {
      // e.g., "doc.fr.md" matches option "fr" with extensionPrefix
      const extensionPrefix = `.${option}`;
      if (path.includes(`${extensionPrefix}.`)) {
        return path.replace(`${extensionPrefix}.`, ".");
      }
    } else if (type === "folder") {
      // e.g., "fr/doc.md" matches option "fr" with folder
      if (path.startsWith(`${option}/`)) {
        return path.slice(option.length + 1);
      }
    }
    return null;
  }

  /**
   * Parse a variant combo string into a map of variant key to option
   * e.g., "locale:en|version:v1" => { locale: "en", version: "v1" }
   */
  private parseVariantCombo(combo: string): Record<string, string> {
    if (combo === "__") return {};
    const result: Record<string, string> = {};
    for (const part of combo.split("|")) {
      const [key, value] = part.split(":");
      result[key] = value;
    }
    return result;
  }

  index(
    args: { ref: string; oid: string; path: string; content: string },
    cache: Cache,
  ): { indexed: true; collection: string } | { indexed: false } {
    const { ref, oid, content } = args;
    // `filePath` (not `path`) avoids shadowing `node:path` in bundled server code.
    const filePath = String(args.path).replace(/^\/+/, "");
    const maybeCollection = this.maybeBuildCollectionForPath(filePath);
    if (!maybeCollection) {
      return { indexed: false };
    }
    const { name, schema } = maybeCollection;

    // `schema.schema` is `z.core.$ZodType` after our shape-preserving refactor.
    // Runtime it is still a Zod schema (codec), so we call via `any` and fall back
    // from v4 `safeDecode` to `safeParse`.
    const _codec: any = schema.schema as any;
    const result = _codec.safeDecode
      ? _codec.safeDecode(content)
      : _codec.safeParse
        ? _codec.safeParse(content)
        : { success: false, error: new Error("no parse") };

    if (result.error || !result.success) {
      return { indexed: false };
    }

    const addFilter = (
      _variant: string,
      _canonical: string,
      field: string,
      key: string,
      value: string,
    ) => {
      cache.filters.push({
        ...this.namespace,
        ref,
        path: filePath,
        field,
        key,
        value,
      });
    };

    const slug = deriveSlug(filePath, {
      basePath: (schema as unknown as { basePath?: string }).basePath,
      match: schema.match,
    });

    const addEntry = (
      variant: string,
      canonical: string,
      collection: string,
    ) => {
      cache.entries.push({
        ref,
        path: filePath,
        variant,
        canonical,
        slug,
        collection,
        oid,
      });
    };

    const addConnection = (
      _variant: string,
      _canonical: string,
      field: string,
      key: string,
      to: string,
      referencedAs: string | null,
      literal: string,
      collection: string,
    ) => {
      cache.connections.push({
        ...this.namespace,
        ref,
        path: filePath,
        field,
        key,
        to,
        referencedAs,
        literal,
        collection,
      });
    };

    const processVariant = (variant: string, canonical: string) => {
      zodVisitor({
        schema: schema.schema,
        value: result.data,
        variant,
        skipMutations: true,
        onFilter: (args) => {
          addFilter(
            variant,
            canonical,
            args.field.join("."),
            args.key.join("."),
            args.value,
          );
        },
        onConnection: (args) => {
          const connectionTarget = String(args.value);
          let fullPath: string;
          // If path starts with './', treat it as root-relative
          if (connectionTarget.startsWith("./")) {
            fullPath = normalize(connectionTarget.slice(2));
          } else if (connectionTarget.startsWith("/")) {
            // Absolute path
            fullPath = normalize(connectionTarget);
          } else {
            // Relative to current file's directory
            fullPath = normalize(join(dirname(filePath), connectionTarget));
          }
          // Convert target path to canonical (strip variant path modifiers)
          let toCanonical = fullPath;
          const variants = this.configObject.variants;
          if (variants) {
            for (const [variantKey, variantConfig] of Object.entries(
              variants,
            )) {
              if (!variantConfig.pathModifier) continue;
              for (const option of variantConfig.options) {
                const matched = this.matchPathToVariantOption(
                  fullPath,
                  variantKey,
                  option,
                );
                if (matched) {
                  toCanonical = matched;
                  break;
                }
              }
            }
          }
          addConnection(
            variant,
            canonical,
            args.field.join("."),
            args.key.join("."),
            toCanonical,
            args.referencedAs ?? null,
            connectionTarget,
            args.collection,
          );
        },
      });
    };

    // Add worktree entry (shared across versions, keyed by path)
    // addWorktreeEntry();

    const variants = this.configObject.variants;

    if (variants && Object.keys(variants).length > 0) {
      // Check if this file matches variant options across ALL variant dimensions.
      // e.g. "a.fr.v1.md" should match locale:fr AND version:v1.
      // We progressively strip each matched modifier from the path to get the canonical.
      const matchedVariants: Record<string, string> = {};
      let canonical = filePath;

      for (const [variantKey, variantConfig] of Object.entries(variants)) {
        if (!variantConfig.pathModifier) continue;
        for (const option of variantConfig.options) {
          const result = this.matchPathToVariantOption(
            canonical,
            variantKey,
            option,
          );
          if (result) {
            matchedVariants[variantKey] = option;
            canonical = result;
            break;
          }
        }
      }

      if (Object.keys(matchedVariants).length > 0) {
        // File is a variant file: build exact combo from matched + defaults.
        const comboParts: string[] = [];
        for (const [variantKey, variantConfig] of Object.entries(variants)) {
          comboParts.push(`${variantKey}:${matchedVariants[variantKey] ?? variantConfig.default}`);
        }
        const exactCombo = comboParts.join("|");
        processVariant(exactCombo, canonical);
        addEntry(exactCombo, canonical, name);
      } else {
        // Default file: one entry for default combo. Sibling copy in writeCache fills the rest.
        const defaultCombo = this.defaultVariant();
        if (defaultCombo) {
          processVariant(defaultCombo, filePath);
          addEntry(defaultCombo, filePath, name);
        }
      }
    } else {
      // No variants defined, use "__" as the variant
      processVariant("__", filePath);
      addEntry("__", filePath, name);
    }

    return {
      indexed: true,
      collection: name,
    };
  }

  buildEntry(entry: Entry, isConnection: boolean) {
    const { schema } = this.buildCollectionForPath(entry.path);
    const collection = this.getCollectionForPath(entry.path);
    if (!collection) {
      throw new Error(`No collection found for path ${entry.path}`);
    }
    const oid = entry.oid;
    const path = entry.path;
    const slug = entry.slug;
    const _meta = {
      raw: entry.blob.content,
      oid,
      path,
      canonicalPath: entry.canonical,
      slug,
    };
    if (isConnection) {
      // @ts-expect-error
      _meta.value = entry.blob.content;
      // @ts-expect-error
      _meta.resolved = true;
    }

    const _codec2: any = schema.schema as any;
    const decoded = _codec2.decode
      ? _codec2.decode(entry.blob.content)
      : _codec2.parse
        ? _codec2.parse(entry.blob.content)
        : JSON.parse(entry.blob.content);
    const result = decoded;
    zodVisitor({
      schema: schema.schema,
      value: result,
      variant: entry.variant,
      onFilter: () => {},
      onConnection: (args) => {
        const connection = entry.toConnections?.find(
          (c) => c.key === args.key.join("."),
        );
        if (connection?.toEntry) {
          try {
            return this.buildEntry(connection.toEntry, true);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `${msg} (referenced from entry "${entry.path}" via connection "${args.key.join(".")}")`,
            );
          }
        }
        return undefined;
      },
    });
    // console.log(result);

    // Handle reverse connections (linkedFrom)
    if (entry.fromConnections && entry.fromConnections.length > 0) {
      for (const conn of entry.fromConnections) {
        if (conn.fromEntry) {
          let nestedEntry: Awaited<ReturnType<Config["buildEntry"]>>;
          try {
            nestedEntry = this.buildEntry(conn.fromEntry, true);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `${msg} (referenced from entry "${entry.path}" via fromConnection "${conn.key}")`,
            );
          }
          const referencedAs = conn.referencedAs;
          if (!referencedAs) {
            throw new Error(`No referencedAs found for connection ${conn.key}`);
          }
          const existing = result[referencedAs];
          if (existing) {
            if (Array.isArray(existing)) {
              existing.push(nestedEntry);
            } else {
              result[referencedAs] = [existing, nestedEntry];
            }
          } else {
            result[referencedAs] = [nestedEntry];
          }
        }
      }
    }

    // First-class slug/path (not just _meta). Content front-matter wins if it defines slug/path.
    const resultRec = result as Record<string, unknown>;
    const withSystemFields: Record<string, unknown> = {
      ...result,
      _meta,
      _collection: collection,
    };
    if (!Object.prototype.hasOwnProperty.call(resultRec, "slug")) {
      withSystemFields["slug"] = slug;
    }
    if (!Object.prototype.hasOwnProperty.call(resultRec, "path")) {
      withSystemFields["path"] = path;
    }

    return withSystemFields as typeof result & {
      _meta: typeof _meta;
      _collection: typeof collection;
      slug: string;
      path: string;
    };
  }
}

// ---------------------------------------------------------------------------
// Generic, shape-preserving config input. `Colls` captures literal collection
// types (including their `schema` generic) so that `FindTypes` can see
// `z.lazy(() => z.connect(...)).optional()` etc. Previously `ConfigInput`
// was `z.infer<typeof configInputSchema>` where `collections` was
// `Record<string, Collection>` and `Collection["schema"]` was
// `ZodCodec<ZodString, ZodObject>` – that erased inner shape and caused
// `with:{author:true}` to yield `never` after `.d.ts` emit (widened to
// `LooseShape`). Now we keep `Colls` as the source of truth for types; runtime
// validation still goes through `configInputSchema` inside `Config` ctor.
// ---------------------------------------------------------------------------

export type AnyCollection = {
  name: string;
  match: string;
  basePath?: string;
  schema: z.core.$ZodType;
};

export type AnyCollections = Record<string, AnyCollection>;

export type DefineConfigInput<Colls extends AnyCollections = AnyCollections> = {
  org: string;
  repo: string;
  ref: string;
  localPath?: string;
  version?: string;
  collections: Colls;
  variants?: Record<string, z.infer<typeof variantsConfigSchema>>;
};

// For backwards compat, `ConfigInput` stays as the erased runtime type,
// but `defineConfig` is now generic over `Colls` preserving shapes.
export type ConfigInput = {
  org: string;
  repo: string;
  ref: string;
  localPath?: string;
  version?: string;
  collections: AnyCollections;
  variants?: Record<string, z.infer<typeof variantsConfigSchema>>;
};

export type ConfigObject = {
  org: string;
  repo: string;
  ref: string;
  localPath?: string;
  version: string;
  variants?: Record<string, z.infer<typeof variantsConfigSchema>>;
  collections: AnyCollections;
};

export const defineConfig = <const Colls extends AnyCollections>(config: DefineConfigInput<Colls>) => {
  return new Config<Colls>(config as unknown as ConfigInput & { collections: Colls });
};
