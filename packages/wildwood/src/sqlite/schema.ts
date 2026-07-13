import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const _commits = sqliteTable(
  "_commits",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    oid: text("oid").notNull(),
    treeOid: text("tree_oid").notNull(),
    message: text("message").notNull(),
    parent: text("parent"),
    secondParent: text("second_parent"),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email").notNull(),
    authorTimestamp: integer("author_timestamp").notNull(),
    authorTimezoneOffset: integer("author_timezone_offset").notNull(),
    committerName: text("committer_name").notNull(),
    committerEmail: text("committer_email").notNull(),
    committerTimestamp: integer("committer_timestamp").notNull(),
    committerTimezoneOffset: integer("committer_timezone_offset").notNull(),
    pushedAt: integer("pushed_at"),
  },
  (t) => [primaryKey({ columns: [t.orgName, t.repoName, t.oid] })],
);

export const _blobs = sqliteTable(
  "_blobs",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    oid: text("oid").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgName, t.repoName, t.oid] })],
);

export const _refs = sqliteTable(
  "_refs",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    ref: text("ref").notNull(),
    commitOid: text("commit_oid").notNull(),
    remoteCommitOid: text("remote_commit_oid"),
    rootTreeOid: text("root_tree_oid"),
    versions: text("versions"),
  },
  (t) => [primaryKey({ columns: [t.orgName, t.repoName, t.ref] })],
);

export const _trees = sqliteTable(
  "_trees",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    oid: text("oid").notNull(),
    entries: text("entries").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgName, t.repoName, t.oid] })],
);

/**
 * Represents the indexed/parsed content per version/namespace.
 * Links a canonical+variant to a change via path.
 */
export const entries = sqliteTable(
  "entries",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    ref: text("ref").notNull(),
    version: text("version").notNull(),
    variant: text("variant").notNull(),
    canonical: text("canonical").notNull(),
    path: text("path").notNull(),
    slug: text("slug").notNull().default(""),
    collection: text("collection").notNull(),
    oid: text("oid").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.orgName, t.repoName, t.ref, t.version, t.variant, t.canonical],
    }),
  ],
);

export const filters = sqliteTable(
  "filters",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    ref: text("ref").notNull(),
    version: text("version").notNull(),
    path: text("path").notNull(),
    // oid: text("oid").notNull(),
    field: text("field").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.orgName, t.repoName, t.ref, t.version, t.path, t.key],
    }),
  ],
);

export const connections = sqliteTable(
  "connections",
  {
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    ref: text("ref").notNull(),
    version: text("version").notNull(),
    path: text("path").notNull(),
    // oid: text("oid").notNull(),
    field: text("field").notNull(),
    referencedAs: text("referenced_as"),
    key: text("key").notNull(),
    to: text("to").notNull(),
    literal: text("literal").notNull(),
    collection: text("collection").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.orgName, t.repoName, t.ref, t.version, t.path, t.key],
    }),
  ],
);

export const schema = {
  _commits,
  _blobs,
  _refs,
  _trees,
  entries,
  filters,
  connections,
};

export type Schema = typeof schema;
