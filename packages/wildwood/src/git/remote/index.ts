import type { Config } from "@/client/config";
import type { WildwoodAuthConfig } from "@/client/auth";
import type { Commit } from "@/types";

export type PushResult = {
  /** Maps local commit OID -> GitHub commit OID for each pushed commit. */
  commitOidMap: Map<string, string>;
  /** The final commit OID on the remote (HEAD after push). */
  commitOid: string;
  treeOid: string;
  pr?: PrResult;
};

export type PrFieldValue<T> = T | ((prev: T) => T);

export type PrInput = {
  title: PrFieldValue<string>;
  body: PrFieldValue<string>;
  labels?: PrFieldValue<string[]>;
};

export type CreatePrArgs = {
  head: string;
  base: string;
  title: string;
  body: string;
  labels?: string[];
};

export type UpdatePrArgs = {
  pr: number;
  title?: string;
  body?: string;
  labels?: string[];
};

export type PrResult = {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type MergePrArgs = {
  pr: number;
  method?: MergeMethod;
};

export type MergePrResult = {
  commitOid: string;
  merged: boolean;
};

export function resolvePrField<T>(value: PrFieldValue<T>, prev: T): T {
  return typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
}

export abstract class Remote {
  config: Config;
  auth?: WildwoodAuthConfig;
  constructor(args: { auth?: WildwoodAuthConfig; config: Config }) {
    this.config = args.config;
    this.auth = args.auth;
  }

  /** Whether this remote has enough credentials to fetch without local git. Used for error hinting only. */
  hasCredentials?(): boolean {
    return Boolean(this.auth?.github);
  }

  abstract listBranches(): Promise<string[]>;

  abstract fetchCommit(
    args: { ref: string } | { oid: string },
  ): Promise<Commit>;

  abstract fetchBlobs(args: {
    oids: string[];
  }): Promise<{ oid: string; content: string }[]>;

  abstract fetchTree(args: {
    oid: string;
  }): Promise<Record<string, { type: "blob" | "tree"; oid: string }> | null>;

  abstract fetchBlobRaw(args: { oid: string }): Promise<Buffer | null>;

  abstract createBlob(args: {
    content: Uint8Array;
  }): Promise<{ oid: string }>;

  abstract push(args: {
    ref: string;
    /** Commits ordered oldest-first (parents before children). */
    commits: Commit[];
    blobs: { oid: string; content: string }[];
    commitTrees: {
      treeOid: string;
      parentTreeOid: string | null;
      paths: { path: string; oid: string; type: "blob" | "tree" }[];
    }[];
  }): Promise<PushResult>;

  abstract createPr(args: CreatePrArgs): Promise<PrResult>;

  abstract updatePr(args: UpdatePrArgs): Promise<PrResult>;

  abstract findPr(args: {
    head: string;
    base: string;
  }): Promise<PrResult | null>;

  /** Post a comment on the PR (e.g. before merge). NativeRemote throws. */
  abstract createPrComment(args: { pr: number; body: string }): Promise<void>;

  abstract mergePr(args: MergePrArgs): Promise<MergePrResult>;
}
