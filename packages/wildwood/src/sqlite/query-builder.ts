import z from "zod/v4";
import type { Config } from "@/client/config";
import type { FindWorktreeEntriesArgs, WhereClause } from "@/types";

// Query operators that can be applied to any field
const QueryOperatorsSchema = z
  .object({
    eq: z.string().optional(),
    ne: z.string().optional(),
    gt: z.string().optional(),
    gte: z.string().optional(),
    lt: z.string().optional(),
    lte: z.string().optional(),
    in: z.string().array().optional(),
    notIn: z.string().array().optional(),
    like: z.string().optional(),
    ilike: z.string().optional(),
    notLike: z.string().optional(),
    notIlike: z.string().optional(),
    isNull: z.boolean().optional(),
    isNotNull: z.boolean().optional(),
  })
  .refine(
    (obj) => {
      return Object.values(obj).some((val) => val !== undefined);
    },
    {
      message: "At least one query condition must be specified.",
      path: [],
    },
  );

// Base type for recursive where clause - uses lazy evaluation for infinite nesting
const whereClauseSchema: z.ZodType<WhereClause> = z.lazy(() =>
  z.union([
    // AND clause: { AND: [clause1, clause2, ...] }
    z.object({
      AND: z.array(whereClauseSchema),
    }),
    // OR clause: { OR: [clause1, clause2, ...] }
    z.object({
      OR: z.array(whereClauseSchema),
    }),
    // Field conditions: { fieldName: "value" } or { fieldName: { eq: "value", ... } }
    z.record(
      z.string(),
      z.union([
        z.string(), // Simple equality: { field: "value" }
        QueryOperatorsSchema, // Complex operators: { field: { eq: "value", gt: "10" } }
        z.object({
          OR: z.array(QueryOperatorsSchema).min(1, "OR array must have at least one condition"),
        }),
        z.object({
          AND: z.array(QueryOperatorsSchema).min(1, "AND array must have at least one condition"),
        }),
        z.record(
          z.string(),
          z.union([
            z.string(), // Simple equality: { field: "value" }
            QueryOperatorsSchema, // Complex operators: { field: { eq: "value", gt: "10" } }
            z.object({
              OR: z.array(QueryOperatorsSchema).min(1, "OR array must have at least one condition"),
            }),
            z.object({
              AND: z
                .array(QueryOperatorsSchema)
                .min(1, "AND array must have at least one condition"),
            }),
          ]),
        ),
      ]),
    ),
  ]),
);

// Drizzle query format types
type DrizzleFilterValue =
  | string
  | Record<string, string | string[] | boolean | undefined>
  | { OR: Array<Record<string, string | string[] | boolean>> }
  | { AND: Array<Record<string, string | string[] | boolean>> };

type DrizzleConnectionFilter = {
  connections: {
    AND: Array<{
      field: { eq: string };
      change: {
        filters: {
          AND: Array<{
            field: { eq: string };
            value: DrizzleFilterValue;
          }>;
        };
      };
    }>;
  };
};

type DrizzleFilterCondition =
  | {
      filters: {
        field: string;
        value: DrizzleFilterValue;
        version?: string;
      };
    }
  | DrizzleConnectionFilter;

type DrizzleWhereClause =
  | { AND: DrizzleWhereClause[] }
  | { OR: DrizzleWhereClause[] }
  | DrizzleFilterCondition
  | DrizzleFilterCondition[];

// Transform WhereClause to Drizzle query format using Zod
export const toDrizzleWhereClause = whereClauseSchema.transform((clause): DrizzleWhereClause => {
  const transform = (c: WhereClause): DrizzleWhereClause => {
    // Handle AND clause
    if ("AND" in c && Array.isArray(c.AND)) {
      return {
        AND: c.AND.map(transform),
      };
    }

    // Handle OR clause
    if ("OR" in c && Array.isArray(c.OR)) {
      return {
        OR: c.OR.map(transform),
      };
    }

    // Handle field conditions (record of field -> value/operators)
    const entries = Object.entries(c).map(([field, value]) => {
      // Simple string value (equality)
      if (typeof value === "string") {
        return {
          filters: {
            field,
            value,
          },
        };
      }

      // Check if it's a nested OR/AND of operators
      if ("OR" in value && Array.isArray(value.OR)) {
        return {
          filters: {
            field,
            value: {
              OR: value.OR.map((op: z.infer<typeof QueryOperatorsSchema>) => {
                const entries = Object.entries(op).filter(([_, v]) => v !== undefined);
                return Object.fromEntries(entries);
              }),
            },
          },
        };
      }

      if ("AND" in value && Array.isArray(value.AND)) {
        return {
          filters: {
            field,
            value: {
              AND: value.AND.map((op: z.infer<typeof QueryOperatorsSchema>) => {
                const entries = Object.entries(op).filter(([_, v]) => v !== undefined);
                return Object.fromEntries(entries);
              }),
            },
          },
        };
      }

      // Check if this is a nested connection filter
      // (object with keys that aren't known operators)
      const knownOperators = new Set([
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "in",
        "notIn",
        "like",
        "ilike",
        "notLike",
        "notIlike",
        "isNull",
        "isNotNull",
      ]);

      const valueKeys = Object.keys(value);
      const isNestedConnection =
        valueKeys.length > 0 && !valueKeys.every((key) => knownOperators.has(key));

      if (isNestedConnection) {
        // Transform nested connection filter
        const transformNestedField = (
          nestedValue: string | Record<string, unknown>,
        ): DrizzleFilterValue => {
          if (typeof nestedValue === "string") {
            return nestedValue;
          }

          // Check for OR/AND arrays
          if ("OR" in nestedValue && Array.isArray(nestedValue.OR)) {
            return {
              OR: nestedValue.OR.map((op: z.infer<typeof QueryOperatorsSchema>) => {
                const entries = Object.entries(op).filter(([_, v]) => v !== undefined);
                return Object.fromEntries(entries);
              }),
            };
          }

          if ("AND" in nestedValue && Array.isArray(nestedValue.AND)) {
            return {
              AND: nestedValue.AND.map((op: z.infer<typeof QueryOperatorsSchema>) => {
                const entries = Object.entries(op).filter(([_, v]) => v !== undefined);
                return Object.fromEntries(entries);
              }),
            };
          }

          // Regular operators
          const entries = Object.entries(nestedValue).filter(([_, v]) => v !== undefined);
          return Object.fromEntries(entries) as DrizzleFilterValue;
        };

        // Build connection filter structure
        const connectionFilters: Record<string, DrizzleFilterValue> = {};

        for (const [nestedField, nestedValue] of Object.entries(value)) {
          connectionFilters[nestedField] = transformNestedField(
            nestedValue as string | Record<string, unknown>,
          );
        }

        return {
          toConnections: {
            AND: [
              {
                field: { eq: field },
                toEntry: {
                  filters: {
                    AND: Object.entries(connectionFilters).map(([nestedField, nestedValue]) => ({
                      field: { eq: nestedField },
                      value: nestedValue,
                    })),
                  },
                },
              },
            ],
          },
        };
      }

      // Complex operators object (single level)
      const operators = value as Record<string, string | string[] | boolean | undefined>;
      const validEntries = Object.entries(operators).filter(([_, v]) => v !== undefined);

      if (validEntries.length === 0) {
        throw new Error(`No valid operators found for field: ${field}`);
      }

      return {
        filters: {
          field,
          value: Object.fromEntries(validEntries),
        },
      };
    });

    return entries.length === 1
      ? (entries[0] as DrizzleWhereClause)
      : (entries as DrizzleWhereClause);
  };

  return transform(clause);
});

// ── helpers ───────────────────────────────────────────────────────────────

type WithObject = {
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  orderBy?: Record<string, "asc" | "desc">;
  with?: Record<string, WithClauseInput>;
  references?: Record<string, WithClauseInput>;
};
type WithClauseInput = boolean | WithObject;

// Drizzle relational wants a relation name (`toConnections`, `fromConnections`).
// We collect per-field specs and collapse them into a single spec that OR's fields
// so `with: { author: true, tags: true }` doesn't last-wins.
type ToSpec = {
  field: string;
  where?: unknown;
  limit?: number;
  offset?: number;
  orderBy?: Record<string, "asc" | "desc">;
  nestedWith?: Record<string, unknown>;
};
type FromSpec = {
  referencedAs: string;
  entryWhere?: unknown;
  limit?: number;
  offset?: number;
  nestedWith?: Record<string, unknown>;
};

function buildNestedWith(
  clause: Record<string, WithClauseInput>,
  recurseWith: (c: Record<string, WithClauseInput>) => Record<string, unknown>,
  recurseRefs: (r: Record<string, WithClauseInput>) => Record<string, unknown> | undefined,
): Record<string, unknown> {
  // Nested `with` is itself a map of field->input; recurse into it via the main transforms.
  const w = Object.keys(clause).length === 0 ? undefined : recurseWith(clause);
  const r = Object.keys(clause).length === 0 ? undefined : recurseRefs(clause);
  const merged: Record<string, unknown> = { ...(w ?? {}) };
  if (r) Object.assign(merged, r);
  return merged;
}

function blobOnly(): Record<string, unknown> {
  return { blob: { columns: { content: true } } };
}

function toConnsSpecToDrizzle(specs: ToSpec[]): Record<string, unknown> {
  if (specs.length === 0) return {};
  const mkEntryWith = (s: ToSpec | undefined) => {
    const nw = s?.nestedWith ?? blobOnly();
    return {
      where: s?.where,
      limit: s?.limit,
      offset: s?.offset,
      with: nw,
    };
  };

  // Array connections store field as `children.0`, `children.1`, etc.
  // First-class fix: when user asks with:{ children:true }, match exact OR prefix.
  // We use OR of eq + like to cover both single and array connections.
  const fieldClause = (field: string) => ({
    OR: [
      { field: { eq: field } },
      { field: { like: `${field}.%` } },
      { field: { like: `${field}[%` } },
    ],
  });

  if (specs.length === 1) {
    const only = specs[0]!;
    // Connection ordering is stable by key (children.0, children.1, ...). User's orderBy is for toEntry ordering.
    // Pass user orderBy through to the toEntry with.
    return {
      where: fieldClause(only.field),
      with: {
        toEntry: mkEntryWith(only),
      },
      ...(only.limit !== undefined ? { limit: only.limit } : {}),
      ...(only.offset !== undefined ? { offset: only.offset } : {}),
      orderBy: { key: "asc" } as unknown as Record<string, unknown>,
    };
  }

  return {
    where: {
      OR: specs.flatMap((s) => [
        { field: { eq: s.field } },
        { field: { like: `${s.field}.%` } },
        { field: { like: `${s.field}[%` } },
      ]),
    },
    with: {
      toEntry: {
        with: blobOnly(),
      },
    },
    orderBy: { key: "asc" },
  };
}

function fromConnsSpecToDrizzle(specs: FromSpec[]): Record<string, unknown> {
  if (specs.length === 0) return {};
  const mkWith = (s: FromSpec | undefined) => s?.nestedWith ?? blobOnly();
  if (specs.length === 1) {
    const only = specs[0]!;
    const where = only.entryWhere
      ? {
          AND: [{ referencedAs: { eq: only.referencedAs } }, { fromEntry: only.entryWhere }],
        }
      : { referencedAs: { eq: only.referencedAs } };
    return {
      where,
      limit: only.limit,
      offset: only.offset,
      with: { fromEntry: { with: mkWith(only) } },
    };
  }
  return {
    where: { OR: specs.map((s) => ({ referencedAs: { eq: s.referencedAs } })) },
    with: { fromEntry: { with: blobOnly() } },
    orderBy: { key: "asc" },
  };
}

// ── main ─────────────────────────────────────────────────────────────────

export function buildWorktreeQuery(args: FindWorktreeEntriesArgs, config: Config) {
  // 1) entry-level conditions (version, collection, variant, path + delegated filters)
  const namespaceConditions: unknown[] = [
    { version: { eq: config.version } },
    {
      collection: { eq: args.collection },
      variant: { eq: args.variant ?? config.defaultVariant() },
    },
  ];

  if (args.where) {
    const {
      path: pathCond,
      slug: slugCond,
      ...rest
    } = args.where as Record<string, unknown> & {
      path?: string | Record<string, unknown>;
      slug?: string | Record<string, unknown>;
    };

    // First principles: slug and path are real columns on entries.
    // path = repo-relative file path (e.g. "content/docs/intro.md")
    // slug = derived from collection match/basePath (e.g. "intro")
    if (pathCond !== undefined) {
      namespaceConditions.push({ path: pathCond });
    }
    if (slugCond !== undefined) {
      namespaceConditions.push({ slug: slugCond });
    }

    if (Object.keys(rest).length > 0) {
      const whereConditions = toDrizzleWhereClause.parse(rest);

      const addVersion = (cond: DrizzleWhereClause): DrizzleWhereClause => {
        if ("AND" in cond) {
          return { AND: cond.AND.map(addVersion) };
        }
        if ("OR" in cond) {
          return { OR: cond.OR.map(addVersion) };
        }
        if ("filters" in cond) {
          return {
            filters: {
              ...cond.filters,
              version: config.version,
            },
          };
        }
        return cond; // toConnections blob — preserve as-is
      };

      if (Array.isArray(whereConditions)) {
        for (const c of whereConditions) namespaceConditions.push(addVersion(c));
      } else {
        namespaceConditions.push(addVersion(whereConditions));
      }
    }
  }

  const query = namespaceConditions.length > 0 ? { AND: namespaceConditions } : undefined;

  // 2) with / references — transform recursively, merging multiple fields.

  // Forward declarations (need mutual recursion).
  let transformWith: (clause?: Record<string, WithClauseInput>) => Record<string, unknown>;
  let transformReferences: (
    clause?: Record<string, WithClauseInput>,
  ) => Record<string, unknown> | undefined;

  transformWith = (clause?: Record<string, WithClauseInput>): Record<string, unknown> => {
    if (!clause) {
      // Default when no `with` — caller wants all connections + blob.
      return {
        blob: { columns: { content: true } },
        toConnections: {
          with: { toEntry: { with: blobOnly() } },
        },
      };
    }

    const toSpecs: ToSpec[] = [];
    const fromSpecs: FromSpec[] = [];
    const passthrough: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(clause)) {
      if (key === "filters" || key === "change") {
        passthrough[key] = value;
        continue;
      }

      if (value === true) {
        toSpecs.push({ field: key, nestedWith: blobOnly() });
        continue;
      }

      if (typeof value === "object" && value !== null) {
        const obj = value as WithObject;
        const entryWhere = obj.where
          ? toDrizzleWhereClause.parse(obj.where as WhereClause)
          : undefined;

        // Nested `with` / `references` inside this connection request.
        const nestedWith = obj.with
          ? transformWith(obj.with as Record<string, WithClauseInput>)
          : undefined;
        const nestedRefs = obj.references
          ? transformReferences(obj.references as Record<string, WithClauseInput>)
          : undefined;
        // Merge nested with+refs into a single `with` map for the toEntry/fromEntry relation.
        const mergedNested: Record<string, unknown> = {
          ...(nestedWith ?? {}),
          ...(nestedRefs ?? {}),
        };

        toSpecs.push({
          field: key,
          where: entryWhere,
          limit: obj.limit,
          offset: obj.offset,
          orderBy: obj.orderBy as Record<string, "asc" | "desc"> | undefined,
          nestedWith: Object.keys(mergedNested).length > 0 ? mergedNested : blobOnly(),
        });
      }
    }

    const built: Record<string, unknown> = {
      blob: { columns: { content: true } },
      ...passthrough,
    };
    if (toSpecs.length > 0) {
      built.toConnections = toConnsSpecToDrizzle(toSpecs);
    } else {
      // No explicit toConnections — still include blob + default toConnections from base if caller
      // used passthrough keys without a with field, etc. Preserve previous behavior:
      built.toConnections = {
        with: { toEntry: { with: blobOnly() } },
      };
    }
    if (fromSpecs.length > 0) {
      built.fromConnections = fromConnsSpecToDrizzle(fromSpecs);
    }
    return built;
  };

  transformReferences = (
    clause?: Record<string, WithClauseInput>,
  ): Record<string, unknown> | undefined => {
    if (!clause) return undefined;

    const fromSpecs: FromSpec[] = [];

    for (const [key, value] of Object.entries(clause)) {
      if (value === true) {
        fromSpecs.push({ referencedAs: key, nestedWith: blobOnly() });
        continue;
      }
      if (typeof value === "object" && value !== null) {
        const obj = value as WithObject;
        const entryWhere = obj.where
          ? toDrizzleWhereClause.parse(obj.where as WhereClause)
          : undefined;

        const nestedWith = obj.with
          ? transformWith(obj.with as Record<string, WithClauseInput>)
          : undefined;
        const nestedRefs = obj.references
          ? transformReferences(obj.references as Record<string, WithClauseInput>)
          : undefined;
        const mergedNested: Record<string, unknown> = {
          ...(nestedWith ?? {}),
          ...(nestedRefs ?? {}),
        };
        fromSpecs.push({
          referencedAs: key,
          entryWhere,
          limit: obj.limit,
          offset: obj.offset,
          nestedWith: Object.keys(mergedNested).length > 0 ? mergedNested : blobOnly(),
        });
      }
    }

    if (fromSpecs.length === 0) return undefined;
    return { fromConnections: fromConnsSpecToDrizzle(fromSpecs) };
  };

  const withClause = transformWith(args.with);
  const referencesClause = transformReferences(args.references);

  // Merge `with` and `references` contributions. Both may touch toConnections/fromConnections.
  // When both provide a given relation, OR their wheres and shallow-merge their `with` shape.
  const mergeConns = (
    a: Record<string, unknown> | undefined,
    b: Record<string, unknown> | undefined,
    connKey: "toConnections" | "fromConnections",
  ): unknown => {
    const ca = (a as Record<string, unknown> | undefined)?.[connKey] as
      | Record<string, unknown>
      | undefined;
    const cb = (b as Record<string, unknown> | undefined)?.[connKey] as
      | Record<string, unknown>
      | undefined;
    if (!ca) return cb;
    if (!cb) return ca;

    const wa = (ca as Record<string, unknown>).where as Record<string, unknown> | undefined;
    const wb = (cb as Record<string, unknown>).where as Record<string, unknown> | undefined;
    const mergedWhere = wa && wb ? { OR: [wa, wb] } : (wa ?? wb);
    const withA = ((ca as Record<string, unknown>).with as Record<string, unknown>) ?? {};
    const withB = ((cb as Record<string, unknown>).with as Record<string, unknown>) ?? {};
    return {
      where: mergedWhere,
      with: { ...withA, ...withB },
      orderBy: (ca as Record<string, unknown>).orderBy ?? (cb as Record<string, unknown>).orderBy,
      limit: (cb as Record<string, unknown>).limit ?? (ca as Record<string, unknown>).limit,
      offset: (cb as Record<string, unknown>).offset ?? (ca as Record<string, unknown>).offset,
    };
  };

  const finalWithClause: Record<string, unknown> = {
    ...withClause,
    ...(referencesClause ?? {}),
  };
  const mergedTo = mergeConns(
    withClause as Record<string, unknown>,
    referencesClause as Record<string, unknown> | undefined,
    "toConnections",
  );
  const mergedFrom = mergeConns(
    withClause as Record<string, unknown>,
    referencesClause as Record<string, unknown> | undefined,
    "fromConnections",
  );
  if (mergedTo) finalWithClause.toConnections = mergedTo;
  if (mergedFrom) finalWithClause.fromConnections = mergedFrom;

  return {
    query,
    finalWithClause,
    limit: args.limit,
    offset: args.offset,
  };
}
