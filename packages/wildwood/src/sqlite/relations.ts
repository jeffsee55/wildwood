import { defineRelations } from "drizzle-orm";
import * as schema from "@/sqlite/schema";

export const relations = defineRelations(schema, (r) => {
  return {
    _commits: {},
    _refs: {
      commit: r.one._commits({
        from: [r._refs.orgName, r._refs.repoName, r._refs.commitOid],
        to: [r._commits.orgName, r._commits.repoName, r._commits.oid],
      }),
      rootTree: r.one._trees({
        from: [r._refs.orgName, r._refs.repoName, r._refs.rootTreeOid],
        to: [r._trees.orgName, r._trees.repoName, r._trees.oid],
      }),
      entries: r.many.entries({
        from: [r._refs.orgName, r._refs.repoName, r._refs.ref],
        to: [r.entries.orgName, r.entries.repoName, r.entries.ref],
      }),
    },
    entries: {
      blob: r.one._blobs({
        from: [r.entries.orgName, r.entries.repoName, r.entries.oid],
        to: [r._blobs.orgName, r._blobs.repoName, r._blobs.oid],
      }),
      siblings: r.many.entries({
        from: [r.entries.orgName, r.entries.repoName, r.entries.ref, r.entries.canonical],
        to: [r.entries.orgName, r.entries.repoName, r.entries.ref, r.entries.canonical],
      }),
      // Forward: entry's field points away. Row lives at entry.path.
      toConnections: r.many.connections({
        from: [r.entries.orgName, r.entries.repoName, r.entries.version, r.entries.path],
        to: [
          r.connections.orgName,
          r.connections.repoName,
          r.connections.version,
          r.connections.path,
        ],
      }),
      // Reverse: other entries point TO this entry. Row's `to` == this entry's canonical.
      fromConnections: r.many.connections({
        from: [
          r.entries.orgName,
          r.entries.repoName,
          r.entries.ref,
          r.entries.version,
          r.entries.canonical,
        ],
        to: [
          r.connections.orgName,
          r.connections.repoName,
          r.connections.ref,
          r.connections.version,
          r.connections.to,
        ],
      }),
      filters: r.many.filters({
        from: [
          r.entries.orgName,
          r.entries.repoName,
          r.entries.ref,
          r.entries.version,
          r.entries.path,
        ],
        to: [
          r.filters.orgName,
          r.filters.repoName,
          r.filters.ref,
          r.filters.version,
          r.filters.path,
        ],
      }),
    },
    connections: {
      // Forward connection: this entry's field points TO another entry's canonical path.
      // `to` is canonical (stripped of variant modifiers) so it matches entries.canonical.
      toEntry: r.one.entries({
        from: [
          r.connections.orgName,
          r.connections.repoName,
          r.connections.ref,
          r.connections.version,
          r.connections.to,
        ],
        to: [
          r.entries.orgName,
          r.entries.repoName,
          r.entries.ref,
          r.entries.version,
          r.entries.canonical,
        ],
      }),
      // Reverse connection: entries whose `to` points at this entry's path (via referencedAs join).
      fromEntry: r.one.entries({
        from: [
          r.connections.orgName,
          r.connections.repoName,
          r.connections.ref,
          r.connections.version,
          r.connections.path,
        ],
        to: [
          r.entries.orgName,
          r.entries.repoName,
          r.entries.ref,
          r.entries.version,
          r.entries.path,
        ],
      }),
    },
    remotes: {},
    _blobs: {},
  };
});
