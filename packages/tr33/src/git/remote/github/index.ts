import { execSync } from "node:child_process";
import { graphql } from "@octokit/graphql";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import {
  type CreatePrArgs,
  type MergePrArgs,
  type MergePrResult,
  type PrResult,
  type PushResult,
  Remote,
  type UpdatePrArgs,
} from "@/git/remote";
import type { Commit } from "@/types";
import { commitSchema } from "@/types";

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

function getGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!token) {
      throw new Error("gh auth token returned empty result");
    }

    return token;
  } catch (error) {
    throw new Error(
      "Failed to get GitHub token. Either set GITHUB_TOKEN env var or authenticate with `gh auth login`.\n" +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class GitHubRemote extends Remote {
  private githubClientPromise: Promise<{
    graphqlClient: typeof graphql;
    octokit: Octokit;
  }> | null = null;
  private owner: string;
  private repo: string;

  constructor(...args: ConstructorParameters<typeof Remote>) {
    const [baseArgs] = args;
    super(baseArgs);
    this.owner = this.config.org;
    this.repo = this.config.repo;
  }

  private async getGitHubClient(): Promise<{
    graphqlClient: typeof graphql;
    octokit: Octokit;
  }> {
    if (this.githubClientPromise) {
      return this.githubClientPromise;
    }
    this.githubClientPromise = (async () => {
      const token = await this.getAuthToken();
      return {
        octokit: new Octokit({ auth: token }),
        graphqlClient: graphql.defaults({
          headers: {
            authorization: `token ${token}`,
          },
        }),
      };
    })();
    return this.githubClientPromise;
  }

  private async getAuthToken(): Promise<string> {
    const githubAuth = this.auth?.github;
    if (githubAuth?.type === "token") {
      return githubAuth.token;
    }
    if (githubAuth?.type === "app") {
      const appAuth = createAppAuth({
        appId: githubAuth.app.appId,
        privateKey: normalizePrivateKey(githubAuth.app.privateKey),
      });
      const installationId =
        githubAuth.app.installationId ??
        (await this.resolveInstallationId(appAuth));
      const installation = await appAuth({
        type: "installation",
        installationId: Number(installationId),
      });
      return installation.token;
    }
    return getGitHubToken();
  }

  /** Whether this app is installed on the configured owner/repo (no installation token). */
  async getRepoInstallationStatus(): Promise<
    | { status: "installed"; installationId: number }
    | { status: "not_installed" }
    | { status: "not_configured" }
  > {
    const githubAuth = this.auth?.github;
    if (githubAuth?.type !== "app") {
      return { status: "not_configured" };
    }
    const appAuth = createAppAuth({
      appId: githubAuth.app.appId,
      privateKey: normalizePrivateKey(githubAuth.app.privateKey),
    });
    if (githubAuth.app.installationId) {
      return {
        status: "installed",
        installationId: Number(githubAuth.app.installationId),
      };
    }
    try {
      const installationId = await this.resolveInstallationId(appAuth);
      return { status: "installed", installationId };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("GitHub App is not installed")
      ) {
        return { status: "not_installed" };
      }
      throw error;
    }
  }

  private async resolveInstallationId(
    appAuth: ReturnType<typeof createAppAuth>,
  ): Promise<number> {
    const appAuthentication = await appAuth({ type: "app" });
    const appOctokit = new Octokit({ auth: appAuthentication.token });
    try {
      const response = await appOctokit.apps.getRepoInstallation({
        owner: this.owner,
        repo: this.repo,
      });
      return response.data.id;
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { status: number }).status
          : undefined;
      if (status === 404) {
        throw new Error(
          `GitHub App is not installed on ${this.owner}/${this.repo}. ` +
            "Install the app on that repository or set GITHUB_APP_INSTALLATION_ID.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async listBranches(): Promise<string[]> {
    const { octokit } = await this.getGitHubClient();
    const branches: string[] = [];
    let page = 1;
    while (true) {
      const response = await octokit.repos.listBranches({
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
        page,
      });
      for (const branch of response.data) {
        branches.push(branch.name);
      }
      if (response.data.length < 100) break;
      page++;
    }
    return branches;
  }

  async fetchCommit(args: { ref: string } | { oid: string }) {
    const { graphqlClient } = await this.getGitHubClient();
    const ref = "ref" in args ? args.ref : args.oid;

    const query = `
			query GetCommit($owner: String!, $repo: String!, $ref: String!) {
				repository(owner: $owner, name: $repo) {
					object(expression: $ref) {
						... on Commit {
							oid
							message
							author {
								name
								email
								date
							}
							committer {
								name
								email
								date
							}
							parents(first: 2) {
								nodes {
									oid
								}
							}
							tree {
								oid
							}
						}
					}
				}
			}
		`;

    const result = await graphqlClient<{
      repository: {
        object: {
          oid: string;
          message: string;
          author: { name: string; email: string; date: string };
          committer: { name: string; email: string; date: string };
          parents: { nodes: { oid: string }[] };
          tree: { oid: string };
        } | null;
      };
    }>(query, {
      owner: this.owner,
      repo: this.repo,
      ref,
    });

    const commit = result.repository.object;
    if (!commit) {
      throw new Error(`Commit not found for ref: ${ref}`);
    }

    const parents = commit.parents.nodes;

    return commitSchema.parse({
      oid: commit.oid,
      message: commit.message,
      author: {
        name: commit.author.name || "Unknown",
        email: commit.author.email || "",
        timestamp: Math.floor(new Date(commit.author.date).getTime() / 1000),
        timezoneOffset: 0,
      },
      committer: {
        name: commit.committer.name || "Unknown",
        email: commit.committer.email || "",
        timestamp: Math.floor(new Date(commit.committer.date).getTime() / 1000),
        timezoneOffset: 0,
      },
      parent: parents[0]?.oid ?? null,
      secondParent: parents[1]?.oid ?? null,
      treeOid: commit.tree.oid,
    });
  }

  async fetchTree({ oid }: { oid: string }) {
    const { graphqlClient } = await this.getGitHubClient();
    const query = `
			query GetTree($owner: String!, $repo: String!, $oid: GitObjectID!) {
				repository(owner: $owner, name: $repo) {
					object(oid: $oid) {
						... on Tree {
							entries {
								name
								oid
								type
							}
						}
					}
				}
			}
		`;

    const result = await graphqlClient<{
      repository: {
        object: {
          entries: Array<{
            name: string;
            oid: string;
            type: string;
          }>;
        } | null;
      };
    }>(query, {
      owner: this.owner,
      repo: this.repo,
      oid,
    });

    const tree = result.repository.object;
    if (!tree || !tree.entries) {
      return null;
    }

    return tree.entries.reduce(
      (acc, entry) => {
        acc[entry.name] = {
          type: entry.type.toLowerCase() === "tree" ? "tree" : "blob",
          oid: entry.oid,
        };
        return acc;
      },
      {} as Record<string, { type: "blob" | "tree"; oid: string }>,
    );
  }

  async fetchBlobs(args: {
    oids: string[];
  }): Promise<{ oid: string; content: string }[]> {
    const { octokit } = await this.getGitHubClient();
    if (args.oids.length === 0) {
      return [];
    }

    const blobPromises = args.oids.map(async (oid) => {
      const response = await octokit.git.getBlob({
        owner: this.owner,
        repo: this.repo,
        file_sha: oid,
      });

      const content =
        response.data.encoding === "base64"
          ? Buffer.from(response.data.content, "base64").toString("utf-8")
          : response.data.content;

      return { oid, content };
    });

    return Promise.all(blobPromises);
  }

  async fetchBlobRaw(args: { oid: string }): Promise<Buffer | null> {
    const { octokit } = await this.getGitHubClient();
    try {
      const response = await octokit.git.getBlob({
        owner: this.owner,
        repo: this.repo,
        file_sha: args.oid,
      });
      return Buffer.from(response.data.content, "base64");
    } catch {
      return null;
    }
  }

  async createBlob(args: { content: Uint8Array }): Promise<{ oid: string }> {
    const { octokit } = await this.getGitHubClient();
    const response = await octokit.git.createBlob({
      owner: this.owner,
      repo: this.repo,
      content: Buffer.from(args.content).toString("base64"),
      encoding: "base64",
    });
    return { oid: response.data.sha };
  }

  async push(args: {
    ref: string;
    commits: Commit[];
    blobs: { oid: string; content: string }[];
    commitTrees: {
      treeOid: string;
      parentTreeOid: string | null;
      paths: { path: string; oid: string; type: "blob" | "tree" }[];
    }[];
  }): Promise<PushResult> {
    const { octokit } = await this.getGitHubClient();
    const { ref, commits, blobs, commitTrees } = args;

    // 1. Create blobs
    const blobOidMap = new Map<string, string>();
    for (const blob of blobs) {
      const response = await octokit.git.createBlob({
        owner: this.owner,
        repo: this.repo,
        content: Buffer.from(blob.content).toString("base64"),
        encoding: "base64",
      });
      if (response.data.sha !== blob.oid) {
        throw new Error(
          `Blob OID mismatch: expected ${blob.oid}, GitHub returned ${response.data.sha}`,
        );
      }
      blobOidMap.set(blob.oid, response.data.sha);
    }

    // 2. Build each commit tree on GitHub via base_tree + flat paths (avoids local tree OID drift).
    const treeOidMap = new Map<string, string>();
    const commitTreeByOid = new Map(
      commitTrees.map((spec) => [spec.treeOid, spec]),
    );

    for (const commit of commits) {
      const spec = commitTreeByOid.get(commit.treeOid);
      if (!spec) {
        throw new Error(`Missing commit tree spec for ${commit.treeOid}`);
      }
      const baseTree =
        spec.parentTreeOid != null
          ? (treeOidMap.get(spec.parentTreeOid) ?? spec.parentTreeOid)
          : undefined;
      const treeItems = spec.paths.map((entry) => ({
        path: entry.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobOidMap.get(entry.oid) ?? entry.oid,
      }));

      const response = await octokit.git.createTree({
        owner: this.owner,
        repo: this.repo,
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: treeItems,
      });
      treeOidMap.set(commit.treeOid, response.data.sha);
    }

    // 3. Create commits (oldest-first, mapping parent OIDs to GitHub's)
    const commitOidMap = new Map<string, string>();
    let lastCommitResponse: { sha: string; tree: { sha: string } } | null =
      null;

    for (const commit of commits) {
      const parents = [commit.parent, commit.secondParent]
        .filter((p): p is string => p !== null)
        .map((p) => commitOidMap.get(p) ?? p);

      const rootTreeSha = treeOidMap.get(commit.treeOid) ?? commit.treeOid;

      const commitResponse = await octokit.git.createCommit({
        owner: this.owner,
        repo: this.repo,
        message: commit.message,
        tree: rootTreeSha,
        parents,
        author: {
          name: commit.author.name,
          email: commit.author.email,
          date: new Date(commit.author.timestamp * 1000).toISOString(),
        },
        committer: commit.committer
          ? {
              name: commit.committer.name,
              email: commit.committer.email,
              date: new Date(commit.committer.timestamp * 1000).toISOString(),
            }
          : undefined,
      });

      const remoteSha = commitResponse.data.sha;
      if (remoteSha !== commit.oid) {
        const ghCommit = commitResponse.data;
        console.warn(
          "Commit OID mismatch — using GitHub's\n" +
            `  local:  ${commit.oid}\n` +
            `  github: ${remoteSha}\n` +
            "  diff:\n" +
            `    tree:      local=${commit.treeOid} github=${ghCommit.tree.sha}\n` +
            `    message:   local=${JSON.stringify(commit.message)} github=${JSON.stringify(ghCommit.message)}\n` +
            `    parents:   local=${JSON.stringify([commit.parent, commit.secondParent].filter(Boolean))} github=${JSON.stringify(ghCommit.parents.map((p) => p.sha))}\n` +
            `    author:    local=${commit.author.name} <${commit.author.email}> ${commit.author.timestamp} github=${ghCommit.author?.name} <${ghCommit.author?.email}> ${ghCommit.author?.date}\n` +
            `    committer: local=${commit.committer?.name} <${commit.committer?.email}> ${commit.committer?.timestamp} github=${ghCommit.committer?.name} <${ghCommit.committer?.email}> ${ghCommit.committer?.date}`,
        );
      }

      commitOidMap.set(commit.oid, remoteSha);
      lastCommitResponse = {
        sha: remoteSha,
        tree: { sha: commitResponse.data.tree.sha },
      };
    }

    if (!lastCommitResponse) {
      throw new Error("No commits to push");
    }

    // 4. Update ref (or create if it doesn't exist yet)
    try {
      await octokit.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${ref}`,
        sha: lastCommitResponse.sha,
      });
    } catch {
      try {
        await octokit.git.createRef({
          owner: this.owner,
          repo: this.repo,
          ref: `refs/heads/${ref}`,
          sha: lastCommitResponse.sha,
        });
      } catch (createError) {
        throw new Error(
          `Failed to update/create ref heads/${ref} to ${lastCommitResponse.sha}: ${createError instanceof Error ? createError.message : String(createError)}`,
        );
      }
    }

    return {
      commitOidMap,
      commitOid: lastCommitResponse.sha,
      treeOid: lastCommitResponse.tree.sha,
    };
  }

  async createPr(args: CreatePrArgs): Promise<PrResult> {
    const { octokit } = await this.getGitHubClient();
    const response = await octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
    });

    const labels = args.labels ?? [];
    if (labels.length > 0) {
      await octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: response.data.number,
        labels,
      });
    }

    return {
      number: response.data.number,
      url: response.data.html_url,
      title: response.data.title,
      body: response.data.body ?? "",
      labels,
    };
  }

  async updatePr(args: UpdatePrArgs): Promise<PrResult> {
    const { octokit } = await this.getGitHubClient();
    const response = await octokit.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: args.pr,
      ...(args.title !== undefined && { title: args.title }),
      ...(args.body !== undefined && { body: args.body }),
    });

    if (args.labels !== undefined) {
      await octokit.issues.setLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: args.pr,
        labels: args.labels,
      });
    }

    return {
      number: response.data.number,
      url: response.data.html_url,
      title: response.data.title,
      body: response.data.body ?? "",
      labels:
        args.labels ??
        response.data.labels.map((l) =>
          typeof l === "string" ? l : (l.name ?? ""),
        ),
    };
  }

  async findPr(args: { head: string; base: string }): Promise<PrResult | null> {
    const { octokit } = await this.getGitHubClient();
    const response = await octokit.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${args.head}`,
      base: args.base,
      state: "open",
      per_page: 1,
    });

    const pr = response.data[0];
    if (!pr) return null;

    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      body: pr.body ?? "",
      labels: pr.labels.map((l) =>
        typeof l === "string" ? l : (l.name ?? ""),
      ),
    };
  }

  async mergePr(args: MergePrArgs): Promise<MergePrResult> {
    const { octokit } = await this.getGitHubClient();
    const response = await octokit.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: args.pr,
      merge_method: args.method ?? "merge",
    });

    return {
      commitOid: response.data.sha,
      merged: response.data.merged,
    };
  }

  async createPrComment(args: { pr: number; body: string }): Promise<void> {
    const { octokit } = await this.getGitHubClient();
    await octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: args.pr,
      body: args.body,
    });
  }
}
