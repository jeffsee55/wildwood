export type TreeEntries = Record<string, { type: "blob" | "tree"; oid: string }>;

export type TreeStore = Record<string, TreeEntries>;

export type CommitAuthor = {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
};

export type CommitNode = {
  oid: string;
  message: string;
  author: CommitAuthor;
  committer?: CommitAuthor;
  parent: string | null;
  secondParent: string | null;
  treeOid: string;
};
