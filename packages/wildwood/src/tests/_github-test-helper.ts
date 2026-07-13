import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class GitHubTestHelper {
  private owner: string;
  private repoName: string;
  private localPath: string;
  private isInitialized = false;

  constructor(prefix = "tr33-test") {
    const uniqueId = randomBytes(6).toString("hex");
    this.repoName = `${prefix}-${uniqueId}`;

    this.owner = execSync("gh api user --jq .login", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    this.localPath = join(__dirname, "fixtures", this.repoName);
  }

  async createRepo(): Promise<void> {
    if (existsSync(this.localPath)) {
      await rm(this.localPath, { recursive: true, force: true });
    }
    await mkdir(this.localPath, { recursive: true });

    execSync(`gh repo create ${this.owner}/${this.repoName} --private --clone`, {
      cwd: join(this.localPath, ".."),
      encoding: "utf-8",
      stdio: "pipe",
    });

    this.runGit("config user.name 'Wildwood Test'");
    this.runGit("config user.email 'tr33-test@example.com'");

    this.isInitialized = true;
  }

  async addFilesAndCommit(
    files: Record<string, string | Buffer>,
    message: string,
  ): Promise<{ oid: string }> {
    this.ensureInitialized();
    await this.addFiles(files);

    this.runGit("add .");
    this.runGit(`commit -m "${message}"`);
    this.runGit("push -u origin HEAD");

    const oid = this.runGit("rev-parse HEAD").trim();
    return { oid };
  }

  async addFiles(files: Record<string, string | Buffer>): Promise<void> {
    this.ensureInitialized();
    for (const filePath of Object.keys(files)) {
      const dir = join(this.localPath, filePath.split("/").slice(0, -1).join("/"));
      if (dir !== this.localPath) {
        await mkdir(dir, { recursive: true });
      }
    }
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(this.localPath, filePath);
      if (Buffer.isBuffer(content)) {
        await writeFile(fullPath, content);
      } else {
        await writeFile(fullPath, content, "utf-8");
      }
    }
  }

  async createBranch(branchName: string): Promise<void> {
    this.ensureInitialized();
    this.runGit(`checkout -b ${branchName}`);
  }

  async switchBranch(branchName: string): Promise<void> {
    this.ensureInitialized();
    this.runGit(`checkout ${branchName}`);
  }

  async createPr(head: string, base: string): Promise<void> {
    this.ensureInitialized();
    this.runGit(`checkout ${head}`);
    execSync(
      `gh pr create --base ${base} --head ${head} --title "Merge ${head} into ${base}" --body "Created by Wildwood playground scenario"`,
      {
        cwd: this.localPath,
        encoding: "utf-8",
        stdio: "pipe",
      },
    );
  }

  getOwner(): string {
    return this.owner;
  }

  getRepoName(): string {
    return this.repoName;
  }

  getFullRepoName(): string {
    return `${this.owner}/${this.repoName}`;
  }

  getLocalPath(): string {
    return this.localPath;
  }

  async reportRateLimit(): Promise<void> {
    try {
      const result = execSync("gh api rate_limit --jq '.resources'", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const resources = JSON.parse(result);
      const graphql = resources.graphql;
      const core = resources.core;
      const resetAt = (r: { reset: number }) => new Date(r.reset * 1000).toLocaleTimeString();
      console.log(
        `GitHub rate limit — GraphQL: ${graphql.remaining}/${graphql.limit} (resets ${resetAt(graphql)}) | REST: ${core.remaining}/${core.limit} (resets ${resetAt(core)})`,
      );
    } catch {
      // Non-critical, don't fail tests
    }
  }

  async cleanup(): Promise<void> {
    try {
      execSync(`gh repo delete ${this.owner}/${this.repoName} --yes`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Repo may not exist if createRepo failed
    }

    if (existsSync(this.localPath)) {
      await rm(this.localPath, { recursive: true, force: true });
    }
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error("Repository not initialized. Call createRepo() first.");
    }
  }

  private runGit(command: string): string {
    return execSync(`git ${command}`, {
      cwd: this.localPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
