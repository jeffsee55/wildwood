import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { minimatch } from "minimatch";
import { hash, schema, sqlBlobs } from "./storage";
import { validPath, variantInfo, variantSql } from "./variants";
import {
  ConflictError,
  ValidationError,
  type BlobStore,
  type Collections,
  type Config,
  type Document,
  type FileChange,
  type Predicate,
  type Query,
  type Ref,
  type Scalar,
  type SnapshotFile,
  type SqlDatabase,
  type SqlExecutor,
} from "./types";

const fieldAt = (data: unknown, field: string): unknown =>
  field
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object" && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined,
      data,
    );
const asRef = (row: Record<string, unknown>): Ref => ({
  name: String(row.name),
  snapshot: String(row.snapshot),
  revision: Number(row.revision),
});

/** Logical file membership: nearest path wins, including deletion tombstones. */
const membership = `WITH RECURSIVE lineage(id, depth) AS (
  SELECT id, 0 FROM ww2_snapshots WHERE id = ? AND repository = ?
  UNION ALL
  SELECT s.parent, l.depth + 1 FROM lineage l JOIN ww2_snapshots s ON s.id = l.id
    WHERE s.parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ww2_checkpoints c WHERE c.snapshot = l.id)
), candidates AS (
  SELECT c.path, c.blob, c.mode, l.depth FROM lineage l JOIN ww2_changes c ON c.snapshot = l.id
    WHERE NOT EXISTS (SELECT 1 FROM ww2_checkpoints k WHERE k.snapshot = l.id)
  UNION ALL
  SELECT c.path, c.blob, c.mode, l.depth FROM lineage l JOIN ww2_checkpoint_files c ON c.snapshot = l.id
), ranked_files AS (
  SELECT path, blob, mode, ROW_NUMBER() OVER (PARTITION BY path ORDER BY depth) AS rank FROM candidates
), effective_files AS (
  SELECT path, blob, mode FROM ranked_files WHERE rank = 1 AND blob IS NOT NULL
)`;

export class ContentEngine<C extends Collections> {
  readonly config: Config<C>;
  readonly blobs: BlobStore;
  private initialized?: Promise<void>;
  private preparing = new Map<string, Promise<void>>();
  constructor(
    readonly database: SqlDatabase,
    config: Config<C>,
    blobs?: BlobStore,
  ) {
    if (!config.repository || !config.version)
      throw new Error("repository and version are required");
    const used = new Set<string>();
    for (const [axis, spec] of Object.entries(config.variants ?? {})) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(axis) ||
        !spec.options.includes(spec.default) ||
        new Set(spec.options).size !== spec.options.length
      )
        throw new Error(`Invalid variant axis: ${axis}`);
      for (const option of spec.options) {
        if (!/^[A-Za-z0-9_-]+$/.test(option) || used.has(option))
          throw new Error(`Variant path tokens must be unambiguous: ${option}`);
        used.add(option);
      }
    }
    for (const collection of Object.values(config.collections)) {
      for (const target of Object.values(collection.references ?? {}))
        if (!config.collections[target]) throw new Error(`Unknown reference collection: ${target}`);
    }
    this.config = Object.freeze({
      ...config,
      collections: Object.freeze(
        Object.fromEntries(
          Object.entries(config.collections).map(([name, c]) => [
            name,
            Object.freeze({
              ...c,
              filters: Object.freeze([...(c.filters ?? [])]),
              references: Object.freeze({ ...c.references }),
            }),
          ]),
        ),
      ) as C,
      variants: Object.freeze(
        Object.fromEntries(
          Object.entries(config.variants ?? {}).map(([name, v]) => [
            name,
            Object.freeze({ ...v, options: Object.freeze([...v.options]) }),
          ]),
        ),
      ),
    });
    this.blobs = blobs ?? sqlBlobs(database);
  }

  async ready() {
    this.initialized ??= (async () => {
      if (this.database.batch) await this.database.batch(schema);
      else for (const sql of schema) await this.database.execute(sql);
      const signature = hash(
        JSON.stringify({
          variants: this.config.variants,
          collections: Object.entries(this.config.collections).map(([name, c]) => ({
            name,
            match: c.match,
            filters: c.filters,
            references: c.references,
            // Function source is neither stable across bundlers nor a schema identity.
            // Parser behavior is identified by the explicit generation version.
          })),
        }),
      );
      await this.database.execute(
        "INSERT INTO ww2_generations(repository,version,signature) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        [this.config.repository, this.config.version, signature],
      );
      const existing = await this.database.execute(
        "SELECT signature FROM ww2_generations WHERE repository=? AND version=?",
        [this.config.repository, this.config.version],
      );
      if (existing.rows[0]?.signature !== signature)
        throw new Error("Schema changed without a version bump");
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    await this.initialized;
  }

  async ref(name: string): Promise<Ref> {
    await this.ready();
    const result = await this.database.execute(
      "SELECT name,snapshot,revision FROM ww2_refs WHERE repository=? AND name=?",
      [this.config.repository, name],
    );
    if (!result.rows[0]) throw new Error(`Unknown ref: ${name}`);
    return asRef(result.rows[0]);
  }

  async branch(name: string, from?: { ref: string } | { snapshot: string }): Promise<Ref> {
    await this.ready();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ||
      name.includes("..") ||
      name.endsWith("/") ||
      name.endsWith(".lock") ||
      name.includes("//")
    )
      throw new Error("Invalid ref name");
    const base = from
      ? "ref" in from
        ? (await this.ref(from.ref)).snapshot
        : from.snapshot
      : hash(`empty:${this.config.repository}`);
    if (from) await this.assertSnapshot(base);
    return this.database.transaction(async (tx) => {
      if (!from)
        await tx.execute(
          "INSERT INTO ww2_snapshots(id,repository,parent,created_at) VALUES(?,?,NULL,?) ON CONFLICT DO NOTHING",
          [base, this.config.repository, new Date().toISOString()],
        );
      const result = await tx.execute(
        "INSERT INTO ww2_refs(repository,name,snapshot,revision) VALUES(?,?,?,0) ON CONFLICT DO NOTHING",
        [this.config.repository, name, base],
      );
      if (!result.changes) throw new ConflictError(`Ref already exists: ${name}`);
      return { name, snapshot: base, revision: 0 };
    });
  }

  private async assertSnapshot(snapshot: string) {
    const result = await this.database.execute(
      "SELECT id FROM ww2_snapshots WHERE id=? AND repository=?",
      [snapshot, this.config.repository],
    );
    if (!result.rows[0]) throw new Error(`Unknown snapshot: ${snapshot}`);
  }
  async files(snapshot: string): Promise<SnapshotFile[]> {
    await this.ready();
    await this.assertSnapshot(snapshot);
    const result = await this.database.execute(
      `${membership} SELECT path,blob,mode FROM effective_files ORDER BY path`,
      [snapshot, this.config.repository],
    );
    return result.rows.map((row) => ({
      path: String(row.path),
      blob: String(row.blob),
      mode: String(row.mode) as SnapshotFile["mode"],
    }));
  }
  async bytes(blob: string): Promise<Uint8Array> {
    const bytes = await this.blobs.get(blob);
    if (!bytes || hash(bytes) !== blob) throw new Error(`Missing or corrupt content: ${blob}`);
    return bytes;
  }

  describe() {
    return {
      repository: this.config.repository,
      version: this.config.version,
      variants: this.config.variants,
      collections: Object.entries(this.config.collections).map(([name, c]) => ({
        name,
        description: c.description,
        match: c.match,
        format: c.parse.format ?? "custom",
        schema: c.parse.jsonSchema ?? null,
        fieldsEditable: !!c.parse.patch,
        filters: c.filters,
        references: c.references,
      })),
    };
  }

  collectionFor(path: string) {
    validPath(path);
    const matches = Object.entries(this.config.collections).filter(([, c]) =>
      minimatch(path, c.match, { dot: true }),
    );
    if (matches.length !== 1)
      throw new ValidationError([
        { path, message: "Path must match exactly one content collection" },
      ]);
    return { name: matches[0][0], ...matches[0][1] };
  }

  /** Validate a proposed content batch without writing blobs, snapshots, or refs. */
  async validateChanges(args: { ref: string; expectedRevision: number; changes: FileChange[] }) {
    const head = await this.ref(args.ref);
    if (head.revision !== args.expectedRevision)
      throw new ConflictError("Ref advanced; read the new revision before editing");
    const diagnostics: { path: string; message: string }[] = [];
    const paths = new Set<string>();
    for (const change of args.changes) {
      try {
        if (paths.has(change.path)) throw new Error("Duplicate change in batch");
        paths.add(change.path);
        const c = this.collectionFor(change.path);
        if (!("delete" in change)) {
          if (change.mode === "120000") throw new Error("Content cannot be a symbolic link");
          c.parse(
            typeof change.content === "string"
              ? change.content
              : new TextDecoder("utf-8", { fatal: true }).decode(change.content),
          );
        }
      } catch (error) {
        diagnostics.push({
          path: change.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      valid: diagnostics.length === 0,
      snapshot: head.snapshot,
      revision: head.revision,
      diagnostics,
    };
  }

  async apply(args: {
    ref: string;
    expectedRevision: number;
    changes: FileChange[];
    idempotencyKey: string;
    audit?: { actor: string; source: string };
    intent?: unknown;
  }): Promise<Ref> {
    await this.ready();
    if (
      !args.idempotencyKey ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      throw new Error("A valid expectedRevision and idempotencyKey are required");
    const paths = new Set<string>();
    const changes = args.changes
      .map((change) => {
        validPath(change.path);
        if (paths.has(change.path)) throw new Error(`Duplicate change: ${change.path}`);
        paths.add(change.path);
        if ("delete" in change)
          return { path: change.path, blob: null, mode: "100644" as const, bytes: undefined };
        const bytes =
          typeof change.content === "string"
            ? new TextEncoder().encode(change.content)
            : new Uint8Array(change.content);
        const mode = change.mode ?? "100644";
        if (!["100644", "100755", "120000"].includes(mode))
          throw new Error("Unsupported file mode");
        return { path: change.path, blob: hash(bytes), mode, bytes };
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    const fingerprint = hash(
      JSON.stringify({
        ref: args.ref,
        expectedRevision: args.expectedRevision,
        version: this.config.version,
        changes: changes.map(({ bytes: _bytes, ...change }) => change),
        intent: args.intent,
      }),
    );
    const prior = await this.command(args.idempotencyKey, fingerprint);
    if (prior) return prior;
    const head = await this.ref(args.ref);
    if (head.revision !== args.expectedRevision) {
      const replay = await this.command(args.idempotencyKey, fingerprint);
      if (replay) return replay;
      throw new ConflictError("Ref advanced; read the new revision before editing");
    }
    for (const change of changes)
      if (change.bytes && change.blob) await this.blobs.put(change.blob, change.bytes);
    const existing = new Map((await this.files(head.snapshot)).map((file) => [file.path, file]));
    const actual = changes.filter((change) =>
      change.blob === null
        ? existing.has(change.path)
        : existing.get(change.path)?.blob !== change.blob ||
          existing.get(change.path)?.mode !== change.mode,
    );
    for (const change of actual)
      change.blob === null
        ? existing.delete(change.path)
        : existing.set(change.path, { path: change.path, blob: change.blob, mode: change.mode });
    for (const path of existing.keys()) {
      const parts = path.split("/");
      for (let n = 1; n < parts.length; n++)
        if (existing.has(parts.slice(0, n).join("/")))
          throw new ValidationError([{ path, message: "A parent path is also a file" }]);
    }
    const snapshot = actual.length ? randomUUID() : head.snapshot;
    if (actual.length) {
      await this.database.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO ww2_snapshots(id,repository,parent,created_at) VALUES(?,?,?,?)",
          [snapshot, this.config.repository, head.snapshot, new Date().toISOString()],
        );
        for (const change of actual)
          await tx.execute("INSERT INTO ww2_changes(snapshot,path,blob,mode) VALUES(?,?,?,?)", [
            snapshot,
            change.path,
            change.blob,
            change.mode,
          ]);
      });
    }
    // Validation and durable bytes precede publication. Failed/racing builds can
    // leave unreachable immutable data, never a partially visible ref.
    await this.prepare(snapshot);
    return this.database.transaction(async (tx) => {
      const replay = await this.command(args.idempotencyKey, fingerprint, tx);
      if (replay) return replay;
      if (
        (
          await tx.execute("SELECT name FROM ww2_ref_locks WHERE repository=? AND name=?", [
            this.config.repository,
            args.ref,
          ])
        ).rows.length
      )
        throw new ConflictError("This ref is read-only");
      const result = {
        name: head.name,
        snapshot,
        revision: head.revision + (actual.length ? 1 : 0),
      };
      const updated = await tx.execute(
        "UPDATE ww2_refs SET snapshot=?,revision=? WHERE repository=? AND name=? AND revision=? AND snapshot=?",
        [snapshot, result.revision, this.config.repository, args.ref, head.revision, head.snapshot],
      );
      if (!updated.changes) throw new ConflictError("Ref advanced while preparing this edit");
      await tx.execute(
        "INSERT INTO ww2_commands(repository,id,fingerprint,result) VALUES(?,?,?,?)",
        [this.config.repository, args.idempotencyKey, fingerprint, JSON.stringify(result)],
      );
      await tx.execute(
        "INSERT INTO ww2_events(repository,id,ref,before_snapshot,snapshot,revision,actor,source,paths,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          this.config.repository,
          args.idempotencyKey,
          head.name,
          head.snapshot,
          snapshot,
          result.revision,
          args.audit?.actor ?? null,
          args.audit?.source ?? "core",
          JSON.stringify(actual.map((c) => c.path)),
          new Date().toISOString(),
        ],
      );
      return result;
    });
  }
  /** Publish an already prepared immutable snapshot with optimistic concurrency. */
  async moveRef(args: {
    ref: string;
    snapshot: string;
    expectedRevision: number;
    expectedSnapshot: string;
    idempotencyKey: string;
    audit?: { actor: string; source: string };
  }): Promise<Ref> {
    await this.ready();
    if (
      !args.idempotencyKey ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      throw new Error("A valid expectedRevision and idempotencyKey are required");
    const fingerprint = hash(
      JSON.stringify({ operation: "moveRef", ...args, version: this.config.version }),
    );
    const prior = await this.command(args.idempotencyKey, fingerprint);
    if (prior) return prior;
    await this.prepare(args.snapshot);
    const before = new Map((await this.files(args.expectedSnapshot)).map((f) => [f.path, f]));
    const after = new Map((await this.files(args.snapshot)).map((f) => [f.path, f]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].filter(
      (path) =>
        before.get(path)?.blob !== after.get(path)?.blob ||
        before.get(path)?.mode !== after.get(path)?.mode,
    );
    return this.database.transaction(async (tx) => {
      const replay = await this.command(args.idempotencyKey, fingerprint, tx);
      if (replay) return replay;
      if (
        (
          await tx.execute("SELECT name FROM ww2_ref_locks WHERE repository=? AND name=?", [
            this.config.repository,
            args.ref,
          ])
        ).rows.length
      )
        throw new ConflictError("This ref is read-only");
      const result = {
        name: args.ref,
        snapshot: args.snapshot,
        revision: args.expectedRevision + 1,
      };
      const updated = await tx.execute(
        "UPDATE ww2_refs SET snapshot=?, revision=? WHERE repository=? AND name=? AND revision=? AND snapshot=?",
        [
          args.snapshot,
          result.revision,
          this.config.repository,
          args.ref,
          args.expectedRevision,
          args.expectedSnapshot,
        ],
      );
      if (!updated.changes)
        throw new ConflictError("Destination advanced; review again before publishing");
      await tx.execute(
        "INSERT INTO ww2_commands(repository,id,fingerprint,result) VALUES(?,?,?,?)",
        [this.config.repository, args.idempotencyKey, fingerprint, JSON.stringify(result)],
      );
      await tx.execute(
        "INSERT INTO ww2_events(repository,id,ref,before_snapshot,snapshot,revision,actor,source,paths,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          this.config.repository,
          args.idempotencyKey,
          args.ref,
          args.expectedSnapshot,
          args.snapshot,
          result.revision,
          args.audit?.actor ?? null,
          args.audit?.source ?? "publication",
          JSON.stringify(paths),
          new Date().toISOString(),
        ],
      );
      return result;
    });
  }
  private async command(
    id: string,
    fingerprint: string,
    tx: SqlExecutor = this.database,
  ): Promise<Ref | null> {
    const prior = await tx.execute(
      "SELECT fingerprint,result FROM ww2_commands WHERE repository=? AND id=?",
      [this.config.repository, id],
    );
    if (!prior.rows[0]) return null;
    if (prior.rows[0].fingerprint !== fingerprint)
      throw new ConflictError("Idempotency key was used for a different command");
    return JSON.parse(String(prior.rows[0].result));
  }

  async prepare(snapshot: string): Promise<void> {
    await this.ready();
    await this.assertSnapshot(snapshot);
    const key = `${snapshot}:${this.config.version}`;
    const active = this.preparing.get(key);
    if (active) return active;
    const work = this.build(snapshot).finally(() => this.preparing.delete(key));
    this.preparing.set(key, work);
    return work;
  }
  private async build(snapshot: string) {
    const version = this.config.version;
    const state = await this.database.execute(
      "SELECT status FROM ww2_builds WHERE snapshot=? AND version=?",
      [snapshot, version],
    );
    if (state.rows[0]?.status === "ready") return;
    await this.database.execute(
      "INSERT INTO ww2_builds(snapshot,version,status) VALUES(?,?,'building') ON CONFLICT(snapshot,version) DO UPDATE SET status='building',diagnostics=NULL",
      [snapshot, version],
    );
    try {
      const files = await this.files(snapshot);
      const diagnostics: { path: string; message: string }[] = [];
      for (const file of files) {
        if (
          file.mode === "120000" &&
          Object.values(this.config.collections).some((c) =>
            minimatch(file.path, c.match, { dot: true }),
          )
        ) {
          diagnostics.push({
            path: file.path,
            message: "Collection documents cannot be symbolic links",
          });
          continue;
        }
        const previous = await this.database.execute(
          "SELECT id FROM ww2_projections WHERE repository=? AND version=? AND path=? AND blob=?",
          [this.config.repository, version, file.path, file.blob],
        );
        if (previous.rows.length) continue;
        const info = variantInfo(file.path, this.config.variants);
        const matches = Object.entries(this.config.collections).filter(([, c]) =>
          minimatch(file.path, c.match, { dot: true }),
        );
        try {
          if (matches.length > 1) throw new Error("File matches more than one collection");
          const [name, collection] = matches[0] ?? [];
          if (collection && file.mode === "120000")
            throw new Error("Collection documents cannot be symbolic links");
          const value = collection
            ? collection.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(await this.bytes(file.blob)),
              )
            : null;
          const data = JSON.stringify(value);
          if (data === undefined)
            throw new Error("Collection parser must return JSON-serializable data");
          const fields = (collection?.filters ?? []).flatMap((field) => {
            const val = fieldAt(value, field);
            if (val === undefined) return [];
            if (val !== null && !["number", "string", "boolean"].includes(typeof val))
              throw new Error(`Filter ${field} must be scalar`);
            if (typeof val === "number" && !Number.isFinite(val))
              throw new Error(`Filter ${field} must be finite`);
            return [
              {
                field,
                kind: val === null ? "null" : typeof val,
                text: typeof val === "string" ? val : null,
                number:
                  typeof val === "number" ? val : typeof val === "boolean" ? Number(val) : null,
              },
            ];
          });
          const connections = Object.entries(collection?.references ?? {}).flatMap(
            ([field, target]) => {
              const val = fieldAt(value, field);
              if (val === undefined || val === null) return [];
              if (typeof val !== "string")
                throw new Error(`Reference ${field} must be a path string`);
              const targetPath = validPath(
                posix.normalize(
                  val.startsWith("/") ? val.slice(1) : posix.join(posix.dirname(file.path), val),
                ),
              );
              return [
                { field, target, path: variantInfo(targetPath, this.config.variants).canonical },
              ];
            },
          );
          const id = hash(JSON.stringify([this.config.repository, version, file.path, file.blob]));
          await this.database.transaction(async (tx) => {
            const inserted = await tx.execute(
              "INSERT INTO ww2_projections(id,repository,version,path,blob,collection,canonical,axes,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
              [
                id,
                this.config.repository,
                version,
                file.path,
                file.blob,
                name ?? null,
                info.canonical,
                JSON.stringify(info.explicit),
                data,
              ],
            );
            if (!inserted.changes) return;
            for (const f of fields)
              await tx.execute(
                "INSERT INTO ww2_fields(projection,field,kind,text_value,number_value) VALUES(?,?,?,?,?)",
                [id, f.field, f.kind, f.text, f.number],
              );
            for (const c of connections)
              await tx.execute(
                "INSERT INTO ww2_connections(projection,field,target_collection,target_path) VALUES(?,?,?,?)",
                [id, c.field, c.target, c.path],
              );
          });
        } catch (error) {
          diagnostics.push({
            path: file.path,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (diagnostics.length) throw new ValidationError(diagnostics);
      await this.database.execute(
        "UPDATE ww2_builds SET status='ready',diagnostics=NULL WHERE snapshot=? AND version=?",
        [snapshot, version],
      );
    } catch (error) {
      await this.database.execute(
        "UPDATE ww2_builds SET status='failed',diagnostics=? WHERE snapshot=? AND version=?",
        [
          JSON.stringify(
            error instanceof ValidationError ? error.diagnostics : [{ message: String(error) }],
          ),
          snapshot,
          version,
        ],
      );
      throw error;
    }
  }

  private selection(snapshot: string, variant?: Record<string, string>) {
    const v = variantSql(this.config.variants, variant);
    return {
      sql: `${membership}, selected_candidates AS (
        SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.collection,p.canonical ORDER BY ${v.order}) AS variant_rank
        FROM effective_files f JOIN ww2_projections p ON p.path=f.path AND p.blob=f.blob
        WHERE p.repository=? AND p.version=? AND p.collection IS NOT NULL AND ${v.allowed}
      ), selected AS (SELECT * FROM selected_candidates WHERE variant_rank=1)`,
      args: [
        snapshot,
        this.config.repository,
        ...v.scoreArgs,
        this.config.repository,
        this.config.version,
        ...v.args,
      ] as Scalar[],
    };
  }
  private predicate(
    predicate: Predicate,
    alias: string,
    collection: string,
    args: Scalar[],
    depth = 0,
  ): string {
    if (depth > 8) throw new Error("Reference/filter nesting exceeds 8 levels");
    if ("and" in predicate || "or" in predicate) {
      const list = "and" in predicate ? predicate.and : predicate.or;
      if (list.length > 100) throw new Error("Too many predicates");
      return list.length
        ? `(${list.map((p) => this.predicate(p, alias, collection, args, depth + 1)).join("and" in predicate ? " AND " : " OR ")})`
        : "and" in predicate
          ? "1=1"
          : "1=0";
    }
    if ("reference" in predicate) {
      const target = this.config.collections[collection].references?.[predicate.reference];
      if (!target) throw new Error(`Unknown reference: ${collection}.${predicate.reference}`);
      const next = `r${depth}`;
      args.push(predicate.reference);
      const where = this.predicate(predicate.where, next, target, args, depth + 1);
      return `EXISTS (SELECT 1 FROM ww2_connections c${depth} JOIN selected ${next} ON ${next}.collection=c${depth}.target_collection AND ${next}.canonical=c${depth}.target_path WHERE c${depth}.projection=${alias}.id AND c${depth}.field=? AND ${where})`;
    }
    if (!this.config.collections[collection].filters?.includes(predicate.field))
      throw new Error(`Field is not indexed: ${collection}.${predicate.field}`);
    const value = "eq" in predicate ? predicate.eq : predicate.gt;
    const kind = value === null ? "null" : typeof value;
    if (
      !["null", "string", "number", "boolean"].includes(kind) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Invalid filter value");
    args.push(predicate.field, kind);
    if (value === null)
      return `EXISTS (SELECT 1 FROM ww2_fields f WHERE f.projection=${alias}.id AND f.field=? AND f.kind=?)`;
    args.push(typeof value === "boolean" ? Number(value) : value);
    return `EXISTS (SELECT 1 FROM ww2_fields f WHERE f.projection=${alias}.id AND f.field=? AND f.kind=? AND f.${typeof value === "string" ? "text_value" : "number_value"} ${"eq" in predicate ? "=" : ">"} ?)`;
  }

  async query<K extends keyof C & string>(
    collection: K,
    options: Query = {},
  ): Promise<{ snapshot: string; version: string; items: Document<ReturnType<C[K]["parse"]>>[] }> {
    if (!this.config.collections[collection]) throw new Error(`Unknown collection: ${collection}`);
    if (options.ref && options.snapshot) throw new Error("Specify either ref or snapshot");
    const snapshot = options.snapshot ?? (await this.ref(options.ref ?? "main")).snapshot;
    await this.prepare(snapshot);
    const selected = this.selection(snapshot, options.variant);
    const args = [...selected.args, collection];
    let where = options.where ? this.predicate(options.where, "d", collection, args) : "1=1";
    if (options.canonical) {
      validPath(options.canonical);
      where += " AND d.canonical=?";
      args.push(options.canonical);
    }
    if (options.search !== undefined) {
      if (!options.search.trim() || options.search.length > 500)
        throw new Error("Search must contain 1..500 characters");
      where +=
        " AND EXISTS (SELECT 1 FROM json_tree(d.data) j WHERE j.type='text' AND instr(lower(j.atom), lower(?)) > 0)";
      args.push(options.search.trim());
    }
    let ordering = "d.canonical ASC";
    if (options.orderBy) {
      const order = options.orderBy;
      if (order.direction && !["asc", "desc"].includes(order.direction))
        throw new Error("Invalid sort direction");
      const target = order.reference
        ? this.config.collections[collection].references?.[order.reference]
        : collection;
      if (!target || !this.config.collections[target].filters?.includes(order.field))
        throw new Error("Sort field is not indexed");
      const fieldValue =
        "CASE WHEN f.kind IN ('number','boolean') THEN f.number_value ELSE f.text_value END";
      let expr: string;
      if (order.reference) {
        args.push(order.reference, order.field);
        expr = `(SELECT ${fieldValue} FROM ww2_connections c JOIN selected r ON r.collection=c.target_collection AND r.canonical=c.target_path JOIN ww2_fields f ON f.projection=r.id WHERE c.projection=d.id AND c.field=? AND f.field=?)`;
      } else {
        args.push(order.field);
        expr = `(SELECT ${fieldValue} FROM ww2_fields f WHERE f.projection=d.id AND f.field=?)`;
      }
      ordering = `${expr} ${order.direction ?? "asc"}, d.canonical ASC`;
    }
    const limit = options.limit ?? 50,
      offset = options.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid pagination; limit must be 1..1000");
    args.push(limit, offset);
    const result = await this.database.execute(
      `${selected.sql} SELECT d.* FROM selected d WHERE d.collection=? AND ${where} ORDER BY ${ordering} LIMIT ? OFFSET ?`,
      args,
    );
    const variant = Object.freeze(
      Object.fromEntries(
        Object.entries(this.config.variants ?? {}).map(([name, axis]) => [
          name,
          options.variant?.[name] ?? axis.default,
        ]),
      ),
    );
    return {
      snapshot,
      version: this.config.version,
      items: result.rows.map((row) => ({
        value: JSON.parse(String(row.data)),
        path: String(row.path),
        canonical: String(row.canonical),
        projection: String(row.id),
        snapshot,
        version: this.config.version,
        variant,
      })),
    };
  }

  /** Resolve a reference in the source document's snapshot, never the moving ref. */
  async resolveReference(
    document: Document<unknown>,
    field: string,
  ): Promise<Document<unknown> | null> {
    if (document.version !== this.config.version)
      throw new Error("Resolve a reference with its original schema generation");
    await this.prepare(document.snapshot);
    const selected = this.selection(document.snapshot, document.variant);
    const result = await this.database.execute(
      `${selected.sql} SELECT target.* FROM selected source JOIN ww2_connections c ON c.projection=source.id JOIN selected target ON target.collection=c.target_collection AND target.canonical=c.target_path WHERE source.id=? AND c.field=?`,
      [...selected.args, document.projection, field],
    );
    const row = result.rows[0];
    return row
      ? {
          value: JSON.parse(String(row.data)),
          path: String(row.path),
          canonical: String(row.canonical),
          projection: String(row.id),
          snapshot: document.snapshot,
          version: document.version,
          variant: document.variant,
        }
      : null;
  }

  /** Rebuildable accelerator. Existing snapshots and their query results do not change. */
  async validateReferences(snapshot: string) {
    await this.prepare(snapshot);
    let variants: Record<string, string>[] = [{}];
    for (const [axis, spec] of Object.entries(this.config.variants ?? {})) {
      if (variants.length * spec.options.length > 256)
        throw new Error("Reference validation supports up to 256 variant combinations");
      variants = variants.flatMap((context) =>
        spec.options.map((value) => ({ ...context, [axis]: value })),
      );
    }
    const diagnostics: { path: string; message: string }[] = [];
    for (const variant of variants) {
      const selected = this.selection(snapshot, variant);
      const result = await this.database.execute(
        `${selected.sql}
        SELECT source.path,c.field,c.target_path FROM selected source
        JOIN ww2_connections c ON c.projection=source.id
        LEFT JOIN selected target ON target.collection=c.target_collection AND target.canonical=c.target_path
        WHERE target.id IS NULL`,
        selected.args,
      );
      for (const row of result.rows)
        diagnostics.push({
          path: String(row.path),
          message: `Unresolved ${row.field}: ${row.target_path} (${JSON.stringify(variant)})`,
        });
    }
    if (diagnostics.length) throw new ValidationError(diagnostics);
  }

  /** Rebuildable accelerator. Existing snapshots and their query results do not change. */
  async checkpoint(snapshot: string) {
    const files = await this.files(snapshot);
    await this.database.transaction(async (tx) => {
      const ready = await tx.execute("SELECT snapshot FROM ww2_checkpoints WHERE snapshot=?", [
        snapshot,
      ]);
      if (ready.rows.length) return;
      for (const file of files)
        await tx.execute(
          "INSERT INTO ww2_checkpoint_files(snapshot,path,blob,mode) VALUES(?,?,?,?)",
          [snapshot, file.path, file.blob, file.mode],
        );
      await tx.execute("INSERT INTO ww2_checkpoints(snapshot) VALUES(?)", [snapshot]);
    });
  }
}
