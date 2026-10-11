export type Scalar = string | number | boolean | null;
export type Row = Record<string, unknown>;
export interface SqlExecutor {
  execute(sql: string, args?: Scalar[]): Promise<{ rows: Row[]; changes: number }>;
}
/** Transactions must be isolated and roll back if the callback rejects. */
export interface SqlDatabase extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Optional atomic DDL batch, avoiding a network round trip per statement. */
  batch?(sql: readonly string[]): Promise<void>;
}
/** Immutable content-addressed bytes. put must never replace different bytes. */
export interface BlobStore {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
}
export type VariantAxis = {
  options: readonly string[];
  default: string;
  path: "suffix" | "folder";
};
export type Collection<T = unknown> = {
  match: string;
  description?: string;
  parse: ContentCodec<T>;
  filters?: readonly string[];
  references?: Readonly<Record<string, string>>;
};
/** Callable parsers remain compatible; codecs additionally support discovery and field edits. */
export type ContentCodec<T = unknown> = ((source: string) => T) & {
  format?: "markdown" | "json";
  jsonSchema?: Record<string, unknown>;
  patch?: (source: string, fields: Record<string, unknown>) => string;
};
export type Collections = Record<string, Collection>;
export type Config<C extends Collections = Collections> = {
  /** Stable repository namespace in the supplied database. */
  repository: string;
  /** Bump when parsing, filters, connections, or variants change. */
  version: string;
  collections: C;
  variants?: Record<string, VariantAxis>;
};
export type Ref = { name: string; snapshot: string; revision: number };
export type FileMode = "100644" | "100755" | "120000";
export type FileChange =
  | { path: string; content: string | Uint8Array; mode?: FileMode }
  | { path: string; delete: true };
export type SnapshotFile = {
  path: string;
  blob: string;
  mode: FileMode;
  size?: number;
  storage?: "default" | "assets";
};
export type Predicate =
  | { field: string; eq: Scalar }
  | { field: string; gt: number | string }
  | { reference: string; where: Predicate }
  | { and: Predicate[] }
  | { or: Predicate[] };
export type Order = { field: string; direction?: "asc" | "desc"; reference?: string };
export type Query = {
  /** Supply either a ref or a pinned immutable snapshot. */
  ref?: string;
  snapshot?: string;
  variant?: Record<string, string>;
  where?: Predicate;
  orderBy?: Order;
  limit?: number;
  offset?: number;
  /** Literal substring in string values, evaluated after variant selection. */
  search?: string;
  canonical?: string;
};
export type Document<T> = {
  value: T;
  path: string;
  canonical: string;
  projection: string;
  snapshot: string;
  version: string;
  variant: Readonly<Record<string, string>>;
};
export class ConflictError extends Error {
  readonly code = "CONFLICT";
}
export class ValidationError extends Error {
  readonly code = "VALIDATION_FAILED";
  constructor(readonly diagnostics: { path: string; message: string }[]) {
    super(diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
  }
}
