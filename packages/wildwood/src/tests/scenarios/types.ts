import type { AnyCollections, DefineConfigInput } from "@/client/config";

export type ScenarioHelper = {
  createBranch(branchName: string): Promise<void>;
  switchBranch(branchName: string): Promise<void>;
  addFiles(files: Record<string, string | Buffer>): Promise<void>;
  addFilesAndCommit(
    files: Record<string, string | Buffer>,
    message: string,
  ): Promise<{ oid?: string; commit?: { oid: string } }>;
  /** Create a PR from head to base (GitHub only). No-op for native. */
  createPr?: (head: string, base: string) => Promise<void>;
};

export type ScenarioConfig = {
  org: string;
  repo: string;
  /** Comparison base ref (e.g. default branch). */
  ref: string;
  /** Ref we're on for this scenario (metadata, pending files). Defaults to ref. */
  currentRef?: string;
};

export type PlaygroundScenarioDefinition = {
  name: string;
  description: string;
  config: ScenarioConfig;
  pendingFiles?: Record<string, string>;
  createConfigInput: (args: {
    org: string;
    repo: string;
    localPath?: string;
  }) => DefineConfigInput<AnyCollections>;
  apply: (helper: ScenarioHelper) => Promise<void>;
};
