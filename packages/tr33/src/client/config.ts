import { dirname, join, normalize } from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod/v4";
import type { Cache, Entry, Namespace } from "@/types";
import { zodVisitor } from "@/zod/visitor";

export const collectionSchema = z.object({
  name: z.string(),
  match: z.string(),
  schema: z.custom<z.ZodCodec<z.ZodString, z.ZodObject>>(),
});

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

export class Config<C extends ConfigInput> {
  configObject: ConfigObject;
  configInput: C;
  constructor(config: C) {
    this.configInput = config;
    const parsed = configSchema.decode(config);
    this.configObject = parsed;
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
  get localPath() {
    return this.configObject.localPath;
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

    const result = schema.schema.safeDecode(content);

    if (result.error) {
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
        // Build the exact variant combo from all matched dimensions,
        // filling in defaults for unmatched dimensions.
        const comboParts: string[] = [];
        for (const [variantKey, variantConfig] of Object.entries(variants)) {
          const matched = matchedVariants[variantKey];
          const option = matched ?? variantConfig.default;
          comboParts.push(`${variantKey}:${option}`);
        }
        const exactCombo = comboParts.join("|");
        processVariant(exactCombo, canonical);
        addEntry(exactCombo, canonical, name);
      } else {
        // EDIT: I dont think we can do this here, this only works when
        // the more specific variant comes after the default variant during write
        // cache. It doesn't even check the existing data either. We should only write
        // 1 entry per index. And then during write cache, once we've written to the db,
        // we can query siblings and make sure all variant combos are present.

        // File doesn't match any variant pattern (default file)
        // Write for ALL variant combos with canonical = path
        // These are fallbacks and WON'T override existing variant matches
        const defaultCombo = this.defaultVariant();
        if (defaultCombo) {
          processVariant(defaultCombo, filePath);
          addEntry(defaultCombo, filePath, name);
        }
        // for (const combo of allVariantCombos) {
        // 	console.log("combo", combo, path);
        // 	processVariant(combo, path);
        // 	addEntry(combo, path, name);
        // }
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
    const _meta = {
      raw: entry.blob.content,
      oid,
      path,
      canonicalPath: entry.canonical,
    };
    if (isConnection) {
      // @ts-expect-error
      _meta.value = entry.blob.content;
      // @ts-expect-error
      _meta.resolved = true;
    }

    const result = schema.schema.decode(entry.blob.content);
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
          let nestedEntry: Awaited<
            ReturnType<Config<ConfigInput>["buildEntry"]>
          >;
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

    return { ...result, _meta, _collection: collection };
  }
}

export const defineConfig = <T extends ConfigInput>(config: T) => {
  // const parsed = configSchema.decode(config);
  return new Config<T>(config);
};

export type ConfigInput = z.infer<typeof configInputSchema>;
export type ConfigObject = z.infer<typeof configSchema>;
export type Collection = z.infer<typeof collectionSchema>;
