import type { InferSelectModel } from "drizzle-orm";
import type { _commits } from "@/sqlite/schema";
import type { Commit } from "@/types";

export const formatCommit = (
  commit: InferSelectModel<typeof _commits>,
): Commit => {
  return {
    oid: commit.oid,
    message: commit.message,
    author: {
      name: commit.authorName,
      email: commit.authorEmail,
      timestamp: commit.authorTimestamp,
      timezoneOffset: commit.authorTimezoneOffset,
    },
    committer: {
      name: commit.committerName,
      email: commit.committerEmail,
      timestamp: commit.committerTimestamp,
      timezoneOffset: commit.committerTimezoneOffset,
    },
    parent: commit.parent,
    secondParent: commit.secondParent,
    treeOid: commit.treeOid,
  };
};
