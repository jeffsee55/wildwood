import type { Client } from "@libsql/client";
import type { BlobStore, SqlDatabase, SqlExecutor } from "./types";
import { createHash } from "node:crypto";

export const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const localQueues = new WeakMap<Client, Promise<unknown>>();
export function libsql(client: Client): SqlDatabase {
  const executor = (target: Pick<Client, "execute">): SqlExecutor => ({
    async execute(sql, args = []) {
      const result = await target.execute({ sql, args });
      return {
        rows: result.rows as unknown as Record<string, unknown>[],
        changes: result.rowsAffected,
      };
    },
  });
  // libsql's native transaction() detaches the connection, losing :memory:
  // databases on the next client.execute(). Keep local work on one connection
  // and serialize access so another request cannot join an open transaction.
  if (client.protocol === "file") {
    const direct = executor(client);
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
      const work = (localQueues.get(client) ?? Promise.resolve()).then(fn, fn);
      localQueues.set(
        client,
        work.catch(() => {}),
      );
      return work;
    };
    return {
      execute: (sql, args) => exclusive(() => direct.execute(sql, args)),
      batch: (sql) =>
        exclusive(async () => {
          await client.batch([...sql], "write");
        }),
      transaction: (fn) =>
        exclusive(async () => {
          await direct.execute("BEGIN IMMEDIATE");
          try {
            const result = await fn(direct);
            await direct.execute("COMMIT");
            return result;
          } catch (error) {
            await direct.execute("ROLLBACK");
            throw error;
          }
        }),
    };
  }
  return {
    ...executor(client),
    async batch(sql) {
      await client.batch([...sql], "write");
    },
    async transaction(fn) {
      const tx = await client.transaction("write");
      try {
        const result = await fn(executor(tx));
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    },
  };
}
/** Default bytes live in SQL; remote object storage is an optional adapter. */
export function sqlBlobs(db: SqlDatabase): BlobStore {
  return {
    async put(id, bytes) {
      if (hash(bytes) !== id) throw new Error("Blob identity mismatch");
      await db.execute("INSERT INTO ww2_blobs (id, bytes) VALUES (?, ?) ON CONFLICT DO NOTHING", [
        id,
        Buffer.from(bytes).toString("base64"),
      ]);
    },
    async get(id) {
      const result = await db.execute("SELECT bytes FROM ww2_blobs WHERE id = ?", [id]);
      return result.rows[0] ? Buffer.from(String(result.rows[0].bytes), "base64") : null;
    },
  };
}
export const schema = [
  `CREATE TABLE IF NOT EXISTS ww2_blobs (id TEXT PRIMARY KEY, bytes TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ww2_blob_locations (repository TEXT NOT NULL, id TEXT NOT NULL, storage TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(repository,id))`,
  `CREATE TABLE IF NOT EXISTS ww2_snapshots (id TEXT PRIMARY KEY, repository TEXT NOT NULL, parent TEXT REFERENCES ww2_snapshots(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ww2_changes (snapshot TEXT NOT NULL REFERENCES ww2_snapshots(id), path TEXT NOT NULL, blob TEXT, mode TEXT NOT NULL, PRIMARY KEY (snapshot,path))`,
  `CREATE TABLE IF NOT EXISTS ww2_ref_locks (repository TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(repository,name))`,
  `CREATE TABLE IF NOT EXISTS ww2_refs (repository TEXT NOT NULL, name TEXT NOT NULL, snapshot TEXT NOT NULL REFERENCES ww2_snapshots(id), revision INTEGER NOT NULL, PRIMARY KEY(repository,name))`,
  `CREATE TABLE IF NOT EXISTS ww2_generations (repository TEXT NOT NULL, version TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(repository,version))`,
  `CREATE TABLE IF NOT EXISTS ww2_builds (snapshot TEXT NOT NULL REFERENCES ww2_snapshots(id), version TEXT NOT NULL, status TEXT NOT NULL, diagnostics TEXT, PRIMARY KEY(snapshot,version))`,
  `CREATE TABLE IF NOT EXISTS ww2_projections (id TEXT PRIMARY KEY, repository TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, collection TEXT, canonical TEXT NOT NULL, axes TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(repository,version,path,blob))`,
  `CREATE TABLE IF NOT EXISTS ww2_fields (projection TEXT NOT NULL REFERENCES ww2_projections(id), field TEXT NOT NULL, kind TEXT NOT NULL, text_value TEXT, number_value REAL, PRIMARY KEY(projection,field))`,
  `CREATE INDEX IF NOT EXISTS ww2_fields_text ON ww2_fields(field,kind,text_value,projection)`,
  `CREATE INDEX IF NOT EXISTS ww2_fields_number ON ww2_fields(field,kind,number_value,projection)`,
  `CREATE TABLE IF NOT EXISTS ww2_connections (projection TEXT NOT NULL REFERENCES ww2_projections(id), field TEXT NOT NULL, target_collection TEXT NOT NULL, target_path TEXT NOT NULL, PRIMARY KEY(projection,field))`,
  `CREATE INDEX IF NOT EXISTS ww2_connections_target ON ww2_connections(target_collection,target_path,projection)`,
  `CREATE TABLE IF NOT EXISTS ww2_commands (repository TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(repository,id))`,
  `CREATE TABLE IF NOT EXISTS ww2_events (repository TEXT NOT NULL, id TEXT NOT NULL, ref TEXT NOT NULL, before_snapshot TEXT NOT NULL, snapshot TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT, source TEXT NOT NULL, paths TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(repository,id))`,
  `CREATE INDEX IF NOT EXISTS ww2_events_ref ON ww2_events(repository,ref,revision)`,
  `CREATE TABLE IF NOT EXISTS ww2_checkpoints (snapshot TEXT PRIMARY KEY REFERENCES ww2_snapshots(id))`,
  `CREATE TABLE IF NOT EXISTS ww2_checkpoint_files (snapshot TEXT NOT NULL REFERENCES ww2_snapshots(id), path TEXT NOT NULL, blob TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(snapshot,path))`,
];
