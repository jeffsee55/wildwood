import type { InferSelectModel } from "drizzle-orm";
import z from "zod/v4";
import { connections, filters } from "@/sqlite/schema";

export const commitSchema = z.object({
  oid: z.string(),
  message: z.string(),
  author: z.object({
    name: z.string(),
    email: z.string(),
    timestamp: z.number(),
    timezoneOffset: z.number(),
  }),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
      timestamp: z.number(),
      timezoneOffset: z.number(),
    })
    .optional(),
  parent: z.string().nullable(),
  secondParent: z.string().nullable(),
  treeOid: z.string(),
});

export const blobSchema = z.object({
  oid: z.string(),
  type: z.literal("blob"),
  name: z.string(),
});
export const treeSchema = z.object({
  oid: z.string(),
  type: z.literal("tree"),
  name: z.string(),
  get entries() {
    return z.record(z.string(), z.union([treeSchema, blobSchema]));
  },
});

export const namespaceSchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  // ref: z.string(),
  version: z.string(),
});
const blobRecordSchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  oid: z.string(),
  content: z.string(),
});

// change represents one row in the changes table (file tree, shared across versions)
export const changeSchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  ref: z.string(),
  path: z.string(),
  oid: z.string(),
  blob: blobRecordSchema.optional(),
});

// entry: version-specific indexed content. First principles: slug+path are real columns on entries.
export const entrySchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  ref: z.string(),
  version: z.string(),
  variant: z.string(),
  canonical: z.string(),
  path: z.string(),
  slug: z.string(),
  collection: z.string(),
  oid: z.string(),
  // change: changeSchema.optional(),
  blob: z.object({
    content: z.string(),
  }),
  get toConnections(): z.ZodLazy<z.ZodOptional<z.ZodArray<typeof connectionSchema>>> {
    return z.lazy(() => connectionSchema.array().optional());
  },
  get fromConnections(): z.ZodLazy<z.ZodOptional<z.ZodArray<typeof connectionSchema>>> {
    return z.lazy(() => connectionSchema.array().optional());
  },
  filters: z.array(z.object({ field: z.string(), value: z.string() })).optional(),
});

const connectionSchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  version: z.string(),
  path: z.string(),
  field: z.string(),
  key: z.string(),
  to: z.string(),
  literal: z.string(),
  collection: z.string(),
  referencedAs: z.string().nullable(),
  get toEntry() {
    return entrySchema.nullish();
  },
  get fromEntry() {
    return entrySchema.nullish();
  },
});

type Connection = z.infer<typeof connectionSchema>;

export type Entry = Omit<z.infer<typeof entrySchema>, "toConnections" | "fromConnections"> & {
  toConnections?: Connection[];
  fromConnections?: Connection[];
};

export const treeRefSchema = z.object({ oid: z.string() });

export const refSchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  ref: z.string(),
  commit: commitSchema,
  rootTree: treeRefSchema.nullable(),
  versions: z.array(z.string()).nullable(),
});

export const worktreeSchema = z.object({
  orgName: z.string(),
  repoName: z.string(),
  ref: z.string(),
  commitOid: z.string(),
  changes: changeSchema.array().optional(),
  entries: entrySchema.array(),
  rootTree: treeRefSchema.optional(),
  versions: z.array(z.string()).optional(),
});

export type Worktree = z.infer<typeof worktreeSchema>;

// Query operators that can be applied to any field
type QueryOperators = {
  eq?: string;
  ne?: string;
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
  in?: string[];
  notIn?: string[];
  like?: string;
  ilike?: string;
  notLike?: string;
  notIlike?: string;
  isNull?: boolean;
  isNotNull?: boolean;
};

// Type definition for nested field value (for connection filters)
type NestedFieldValue =
  | string
  | QueryOperators
  | { OR: QueryOperators[] }
  | { AND: QueryOperators[] };

// Type definition for field value (can be string, operators, nested AND/OR of operators, or nested object)
type FieldValue =
  | string
  | QueryOperators
  | { OR: QueryOperators[] }
  | { AND: QueryOperators[] }
  | Record<string, NestedFieldValue>;

// Type definition for the where clause (needed for z.lazy)
export type WhereClause =
  | { AND: WhereClause[] }
  | { OR: WhereClause[] }
  | Record<string, FieldValue>;

// Recursive with schema for nested relation queries
export type WithClause =
  | boolean
  | {
      where?: WhereClause;
      limit?: number;
      offset?: number;
      with?: Record<string, WithClause>;
      references?: Record<string, WithClause>;
    };

export type FindWorktreeEntriesArgs = {
  collection: string;
  ref?: string;
  limit?: number;
  variant?: string;
  offset?: number;
  orderBy?: Record<string, "asc" | "desc">;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where?: any;
  // Per instructions: ignore with-type errors for now → any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  with?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  references?: any;
};

export type Commit = z.infer<typeof commitSchema>;
export type Ref = z.infer<typeof refSchema>;
export type Tree = z.infer<typeof treeSchema>;
export type Blob = z.infer<typeof blobSchema>;
export type Namespace = z.infer<typeof namespaceSchema>;

// Database / cache types (schema-derived and plain)
export type FilterRecord = InferSelectModel<typeof filters>;
export type ConnectionRecord = InferSelectModel<typeof connections>;
export type ChangeRecord = {
  ref: string;
  path: string;
  oid: string;
};
export type EntryRecord = {
  ref: string;
  path: string;
  canonical: string;
  variant: string;
  collection: string;
  oid: string;
  slug: string;
};
export type Cache = {
  filters: FilterRecord[];
  entries: EntryRecord[];
  connections: ConnectionRecord[];
};
