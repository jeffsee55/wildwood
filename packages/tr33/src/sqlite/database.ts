import type { Client as LibsqlClient } from "@libsql/client";
import { calculateCommitOid } from "tr33-store";
import { and, eq, type InferSelectModel, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { Config, ConfigInput } from "@/client/config";
import { buildWorktreeQuery } from "@/sqlite/query-builder";
import { relations } from "@/sqlite/relations";
import * as schema from "@/sqlite/schema";
import {
  _commits,
  _refs,
  _trees,
  entries,
  filters,
} from "@/sqlite/schema";
import sqlSchema from "@/sqlite/schema.json" with { type: "json" };
import type { Cache, Commit, FindWorktreeEntriesArgs, Ref } from "@/types";
import { refSchema } from "@/types";

const createDrizzle = (client: LibsqlClient) => {
  return drizzle({ client, schema, relations, logger: false });
};

function splitSqlStatements(raw: string): string[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

function isIgnorableSchemaError(err: unknown): boolean {
  return err instanceof Error && /already exists/i.test(err.message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}

/** LibSQL / SQLite errors when Tr33 or Better Auth tables have not been created yet. */
export function isMissingSchemaError(err: unknown): boolean {
  const message = errorMessage(err);
  if (/no such table/i.test(message)) {
    return true;
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = String((err as { code: unknown }).code);
    return code === "SQLITE_ERROR";
  }
  return false;
}

/** Deduplicate `_refs.versions` (order preserved, first occurrence wins). */
function dedupeRefVersions(versions: string[]): string[] {
  return [...new Set(versions)];
}

export type { Cache } from "@/types";

export class LibsqlDatabase {
  client: LibsqlClient;
  config: Config<ConfigInput>;
  drizzle: ReturnType<typeof createDrizzle>;
  schema = schema;

  constructor(args: {
    client: LibsqlClient;
    config: Config<ConfigInput>;
  }) {
    this.client = args.client;
    this.drizzle = createDrizzle(this.client);
    this.config = args.config;
  }

  cache: Cache = {
    filters: [],
    entries: [],
    connections: [],
  };

  writeCache = async (args: {
    status: string;
    cache: Cache;
    /** Skip variant sibling copy — use on incremental editor saves. */
    skipSiblingCopy?: boolean;
  }) => {
    const { cache } = args;
    const filters = cache.filters;
    if (filters.length > 0) {
      await this.drizzle
        .insert(this.schema.filters)
        .values(filters)
        .onConflictDoUpdate({
          target: [
            this.schema.filters.orgName,
            this.schema.filters.repoName,
            this.schema.filters.ref,
            this.schema.filters.version,
            this.schema.filters.path,
            this.schema.filters.key,
          ],
          set: {
            value: sql`excluded.value`,
            path: sql`excluded.path`,
          },
        });
    }
    const connections = cache.connections;
    if (connections.length > 0) {
      await this.drizzle
        .insert(this.schema.connections)
        .values(connections)
        .onConflictDoUpdate({
          target: [
            this.schema.connections.orgName,
            this.schema.connections.repoName,
            this.schema.connections.ref,
            this.schema.connections.version,
            this.schema.connections.path,
            this.schema.connections.key,
          ],
          set: {
            literal: sql`excluded.literal`,
            path: sql`excluded.path`,
          },
        });
    }

    // Entries are version-specific and now first-class on { slug, path }.
    // No back-compat shims — DB was cleared first-principles per request.
    const entriesRows = cache.entries;
    if (entriesRows.length > 0) {
      const rows = entriesRows.map(({ ref, path, variant, canonical, collection, oid, slug }) => ({
        orgName: this.config.org,
        repoName: this.config.repo,
        ref,
        version: this.config.version,
        variant,
        canonical,
        path,
        slug,
        collection,
        oid,
      }));
      await this.drizzle
        .insert(this.schema.entries)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            this.schema.entries.orgName,
            this.schema.entries.repoName,
            this.schema.entries.ref,
            this.schema.entries.version,
            this.schema.entries.variant,
            this.schema.entries.canonical,
          ],
          set: {
            path: sql`excluded.path`,
            slug: sql`excluded.slug`,
            collection: sql`excluded.collection`,
            oid: sql`excluded.oid`,
          },
        });
    }
    if (!args.skipSiblingCopy) {
      const canonicals = new Set(cache.entries.map((entry) => entry.canonical));
      const entries2 = await this.drizzle.query.entries.findMany({
        where: {
          path: { in: Array.from(canonicals) },
        },
        with: {
          siblings: true,
        },
      });
      for (const entry of entries2) {
        const missingCombos = this.config.findMissingCombos(
          entry.siblings.map((sibling) => sibling.path),
        );
        for (const missingCombo of missingCombos) {
          await this.entries.copy(missingCombo);
        }
      }
    }

    const changes = cache.entries;

    return changes;
  };

  trees = {
    fromRecord: (
      result: InferSelectModel<typeof _trees>,
    ): { oid: string } => {
      return { oid: result.oid };
    },
    get: async (args: { oid: string }) => {
      const row = await this.drizzle.query._trees.findFirst({
        where: {
          orgName: this.config.org,
          repoName: this.config.repo,
          oid: args.oid,
        },
      });
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.entries) as Record<
          string,
          Record<string, { type: "blob" | "tree"; oid: string }>
        >;
        return parsed[args.oid] ?? null;
      } catch {
        return null;
      }
    },
    batchPut: async (
      trees: {
        oid: string;
        entries: Record<string, { type: "blob" | "tree"; oid: string }>;
      }[],
    ) => {
      if (trees.length === 0) {
        return;
      }
      await this.drizzle
        .insert(this.schema._trees)
        .values(
          trees.map(({ oid, entries }) => ({
            orgName: this.config.org,
            repoName: this.config.repo,
            oid,
            entries: JSON.stringify({ [oid]: entries }),
          })),
        )
        .onConflictDoNothing();
    },
  };

  commits = {
    fromRecord: (result: InferSelectModel<typeof _commits>): Commit => {
      return {
        oid: result.oid,
        treeOid: result.treeOid,
        message: result.message,
        parent: result.parent,
        secondParent: result.secondParent,
        author: {
          name: result.authorName,
          email: result.authorEmail,
          timestamp: result.authorTimestamp,
          timezoneOffset: result.authorTimezoneOffset,
        },
        committer: {
          name: result.committerName,
          email: result.committerEmail,
          timestamp: result.committerTimestamp,
          timezoneOffset: result.committerTimezoneOffset,
        },
      };
    },
    get: async (args: { oid: string }): Promise<Commit | null> => {
      const result = await this.drizzle.query._commits.findFirst({
        where: {
          orgName: this.config.org,
          repoName: this.config.repo,
          oid: args.oid,
        },
      });
      if (!result) {
        return null;
      }
      return this.commits.fromRecord(result);
    },
    getRaw: async (args: { oid: string }) => {
      return this.drizzle.query._commits.findFirst({
        where: {
          orgName: this.config.org,
          repoName: this.config.repo,
          oid: args.oid,
        },
      });
    },
    put: async (args: Omit<Commit, "oid"> & { oid: string | null }) => {
      const oid = args.oid ?? (await calculateCommitOid(args));
      const payload = {
        orgName: this.config.org,
        repoName: this.config.repo,
        oid,
        treeOid: args.treeOid,
        message: args.message,
        parent: args.parent,
        secondParent: args.secondParent,
        authorName: args.author.name,
        authorEmail: args.author.email,
        authorTimestamp: args.author.timestamp,
        authorTimezoneOffset: args.author.timezoneOffset,
        committerName: args.committer?.name ?? args.author.name,
        committerEmail: args.committer?.email ?? args.author.email,
        committerTimestamp: args.committer?.timestamp ?? args.author.timestamp,
        committerTimezoneOffset:
          args.committer?.timezoneOffset ?? args.author.timezoneOffset,
      };
      await this.drizzle
        .insert(this.schema._commits)
        .values(payload)
        .onConflictDoNothing();
      return {
        orgName: this.config.org,
        repoName: this.config.repo,
        ...args,
        oid,
      };
    },
    markPushed: async (args: { oid: string }) => {
      await this.drizzle
        .update(this.schema._commits)
        .set({ pushedAt: Math.floor(Date.now() / 1000) })
        .where(
          and(
            eq(this.schema._commits.orgName, this.config.org),
            eq(this.schema._commits.repoName, this.config.repo),
            eq(this.schema._commits.oid, args.oid),
          ),
        );
    },
  };

  refs = {
    fromRecord: (
      record: typeof _refs.$inferSelect & {
        commit: typeof _commits.$inferSelect | null;
        rootTree: typeof _trees.$inferSelect | null;
      },
    ): Ref => {
      const commit = record.commit;
      if (!commit) {
        throw new Error(`Commit not found for ref ${record.ref}`);
      }
      const rootTree = record.rootTree;
      const result = {
        ...record,
        versions: record.versions
          ? dedupeRefVersions(JSON.parse(record.versions) as string[])
          : null,
        commit: this.commits.fromRecord(commit),
        rootTree: rootTree ? this.trees.fromRecord(rootTree) : null,
      };
      return refSchema.parse(result);
    },
    updateCommit: async (args: { ref: string; commit: Commit }) => {
      const payload = {
        orgName: this.config.org,
        repoName: this.config.repo,
        ref: args.ref,
        commitOid: args.commit.oid,
        remoteCommitOid: args.commit.oid,
      };
      await this.drizzle
        .insert(this.schema._refs)
        .values(payload)
        .onConflictDoUpdate({
          target: [
            this.schema._refs.orgName,
            this.schema._refs.repoName,
            this.schema._refs.ref,
          ],
          set: {
            commitOid: args.commit.oid,
          },
        });
    },
    // biome-ignore lint/suspicious/noExplicitAny: Complex Drizzle return type
    findFirst: async (args: FindWorktreeEntriesArgs): Promise<any> => {
      const { query, finalWithClause, limit, offset } = buildWorktreeQuery(
        args,
        this.config,
      );
      const ref = args.ref || this.config.ref;
      const orderByFilter: { field: string; direction: "asc" | "desc" }[] = [];
      for (const [field, direction] of Object.entries(args.orderBy ?? {})) {
        orderByFilter.push({
          field,
          direction,
        });
      }
      const a = await this.drizzle.query._refs.findFirst({
        where: {
          orgName: this.config.org,
          repoName: this.config.repo,
          ref,
        },
        with: {
          rootTree: true,
          entries: {
            // biome-ignore lint/suspicious/noExplicitAny: Drizzle's relational query types are complex
            where: query as any,
            limit,
            offset,
            // biome-ignore lint/suspicious/noExplicitAny: Drizzle's relational query types are complex
            with: finalWithClause as any,
            // orderBy filters: correlated subselect; direction from orderByFilter (default asc)
            ...(orderByFilter.length > 0
              ? ((() => {
                  const { field, direction = "asc" } = orderByFilter[0] ?? {
                    field: "title",
                  };
                  const sub = (entriesTable: typeof entries) =>
                    sql`(select ${filters.value} from ${filters} where ${and(
                      eq(filters.orgName, entriesTable.orgName),
                      eq(filters.repoName, entriesTable.repoName),
                      eq(filters.ref, entriesTable.ref),
                      eq(filters.version, entriesTable.version),
                      eq(filters.path, entriesTable.path),
                      eq(filters.field, field),
                    )} limit 1)`;
                  return {
                    orderBy: (
                      entriesTable: typeof entries,
                      {
                        asc: a,
                        desc: d,
                      }: {
                        asc: (x: ReturnType<typeof sql>) => unknown;
                        desc: (x: ReturnType<typeof sql>) => unknown;
                      },
                    ) => [(direction === "desc" ? d : a)(sub(entriesTable))],
                  };
                })() as {
                  orderBy: (
                    table: typeof entries,
                    opts: {
                      asc: (x: ReturnType<typeof sql>) => unknown;
                      desc: (x: ReturnType<typeof sql>) => unknown;
                    },
                  ) => unknown[];
                })
              : {}),
            // biome-ignore lint/suspicious/noExplicitAny: Drizzle relational orderBy callback type is complex
          } as any,
        },
      });
      if (!a) return null;
      const versions = a.versions
        ? dedupeRefVersions(JSON.parse(a.versions) as string[])
        : undefined;
      const rootTree = a.rootTree
        ? this.trees.fromRecord(a.rootTree)
        : undefined;
      return {
        ...a,
        rootTree,
        versions,
        treeOid: a.rootTreeOid ?? rootTree?.oid,
      };
    },
    /** List distinct refs that have a worktree (for this org/repo/version). */
    listRefs: async (): Promise<string[]> => {
      const rows = await this.drizzle
        .selectDistinct({ ref: this.schema._refs.ref })
        .from(this.schema._refs)
        .where(
          and(
            eq(this.schema._refs.orgName, this.config.org),
            eq(this.schema._refs.repoName, this.config.repo),
          ),
        );
      return rows.map((r) => r.ref);
    },
    get: async (args: { ref: string }) => {
      const result = await this.drizzle.query._refs.findFirst({
        where: {
          orgName: this.config.org,
          repoName: this.config.repo,
          ref: args.ref,
        },
        with: {
          commit: true,
          rootTree: true,
        },
      });
      if (!result) {
        return null;
      }
      return this.refs.fromRecord(result);
    },
    updateRemoteCommit: async (args: { ref: string; commit: Commit }) => {
      const payload = {
        orgName: this.config.org,
        repoName: this.config.repo,
        ref: args.ref,
        commitOid: args.commit.oid,
        remoteCommitOid: args.commit.oid,
      };
      await this.drizzle
        .insert(this.schema._refs)
        .values(payload)
        .onConflictDoUpdate({
          target: [
            this.schema._refs.orgName,
            this.schema._refs.repoName,
            this.schema._refs.ref,
          ],
          set: {
            commitOid: args.commit.oid,
            remoteCommitOid: args.commit.oid,
          },
        });
      return payload;
    },
    setRemoteCommitOid: async (args: {
      ref: string;
      remoteCommitOid: string;
    }) => {
      await this.drizzle
        .update(this.schema._refs)
        .set({ remoteCommitOid: args.remoteCommitOid })
        .where(
          and(
            eq(this.schema._refs.orgName, this.config.org),
            eq(this.schema._refs.repoName, this.config.repo),
            eq(this.schema._refs.ref, args.ref),
          ),
        );
    },
    setTreeOid: async (args: { ref: string; treeOid: string }) => {
      await this.drizzle
        .update(this.schema._refs)
        .set({ rootTreeOid: args.treeOid })
        .where(
          and(
            eq(this.schema._refs.orgName, this.config.org),
            eq(this.schema._refs.repoName, this.config.repo),
            eq(this.schema._refs.ref, args.ref),
          ),
        );
    },
    updateVersions: async (args: { ref: string; versions: string[] }) => {
      await this.drizzle
        .update(this.schema._refs)
        .set({ versions: JSON.stringify(dedupeRefVersions(args.versions)) })
        .where(
          and(
            eq(this.schema._refs.orgName, this.config.org),
            eq(this.schema._refs.repoName, this.config.repo),
            eq(this.schema._refs.ref, args.ref),
          ),
        );
    },
  };

  entries = {
    copy: async (args: { variant: string; path: string }) => {
      const ns = this.schema.entries;
      await this.drizzle
        .insert(ns)
        .select(
          this.drizzle
            .select({
              orgName: ns.orgName,
              repoName: ns.repoName,
              ref: ns.ref,
              version: ns.version,
              variant: sql<string>`${args.variant}`.as("variant"),
              canonical: ns.canonical,
              path: ns.path,
              slug: ns.slug,
              collection: ns.collection,
              oid: ns.oid,
            })
            .from(ns)
            .where(
              and(
                eq(ns.orgName, this.config.org),
                eq(ns.repoName, this.config.repo),
                eq(ns.ref, this.config.ref),
                eq(ns.version, this.config.version),
                eq(ns.path, args.path),
              ),
            ),
        )
        .onConflictDoNothing();
    },
  };

  blobs = {
    batchGet: async (args: { oids: string[] }) => {
      return this.drizzle.query._blobs.findMany({
        where: {
          oid: { in: args.oids },
        },
      });
    },
    batchPut: async (args: { oid: string; content: string }[]) => {
      if (args.length === 0) {
        return;
      }
      await this.drizzle
        .insert(this.schema._blobs)
        .values(
          args.map(({ oid, content }) => ({
            orgName: this.config.org,
            repoName: this.config.repo,
            oid,
            // Explicitly handle empty strings - ensure they're stored as empty strings, not NULL
            content: content ?? "",
          })),
        )
        .onConflictDoNothing();
    },
  };

  async init() {
    for (const statement of splitSqlStatements(sqlSchema.raw)) {
      try {
        await this.client.execute(statement);
      } catch (err) {
        if (!isIgnorableSchemaError(err)) {
          throw err;
        }
      }
    }
  }

  async clear() {
    for (const item of Object.values(this.drizzle._.schema || {})) {
      const tableName = item.dbName;
      try {
        await this.drizzle.$client.execute(`delete from ${tableName}`);
      } catch {}
    }
  }

  async reset() {
    await this.clear();
    await this.init();
  }
}
