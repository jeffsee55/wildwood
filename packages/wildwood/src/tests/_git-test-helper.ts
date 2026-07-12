import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TestFile {
  path: string;
  content: string;
}

export interface TestCommit {
  message: string;
  files: Record<string, string>;
  branch?: string;
}

export class GitTestHelper {
  private repoPath: string;
  private currentBranch = "main";
  private isInitialized = false;
  private commitTimestamp: Date;

  constructor(repoName?: string) {
    // Generate a unique folder name using random bytes to avoid conflicts between parallel tests
    const uniqueId = randomBytes(8).toString("hex");
    const folderName = repoName ? `${repoName}-${uniqueId}` : uniqueId;
    const path = join(__dirname, "fixtures", folderName);
    this.repoPath = path;
    // Initialize with a fixed base timestamp (January 1, 2024, 00:00:00 UTC)
    this.commitTimestamp = new Date("2024-01-01T00:00:00Z");
  }

  async listBranches(): Promise<string[]> {
    const output = execSync("git branch --format='%(refname:short)'", {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .map((branch) => branch.trim())
      .filter((branch) => branch.length > 0);
  }

  /**
   * Creates a new test repository with the given name
   */
  async createRepo(): Promise<void> {
    // Clean up existing repo if it exists
    if (existsSync(this.repoPath)) {
      await rm(this.repoPath, { recursive: true, force: true });
    }

    // Reset timestamp to base value
    this.commitTimestamp = new Date("2024-01-01T00:00:00Z");

    // Create directory
    await mkdir(this.repoPath, { recursive: true });

    // Initialize git repo
    await this.runGitCommand("init --initial-branch=main");

    // Set user config for commits
    await this.runGitCommand("config user.name 'Test User'");
    await this.runGitCommand("config user.email 'test@example.com'");

    this.isInitialized = true;
  }

  /**
   * Creates a new branch
   */
  async createBranch(branchName: string): Promise<void> {
    this.ensureInitialized();
    await this.runGitCommand(`checkout -b ${branchName}`);
    this.currentBranch = branchName;
  }

  async getTreeOid(): Promise<string> {
    return execSync("git rev-parse HEAD^{tree}", {
      cwd: this.repoPath,
      encoding: "utf-8",
    }).trim();
  }

  async getCatFile(oid: string): Promise<string> {
    return execSync(`git cat-file -p ${oid}`, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
  }

  async getCommitOid(): Promise<string> {
    return execSync("git rev-parse HEAD", {
      cwd: this.repoPath,
      encoding: "utf-8",
    }).trim();
  }

  /**
   * Switches to an existing branch
   */
  async switchBranch(branchName: string): Promise<void> {
    this.ensureInitialized();
    await this.runGitCommand(`checkout ${branchName}`);
    this.currentBranch = branchName;
  }

  /**
   * Adds files and commits them
   */
  async addFilesAndCommit(
    files: Record<string, string | Buffer>,
    commitMessage: string,
  ): Promise<{ commit: { oid: string } }> {
    this.ensureInitialized();
    await this.addFiles(files);

    // Add all files
    await this.runGitCommand("add .");

    // Commit with fixed timestamp
    await this.runGitCommand(`commit -m "${commitMessage}"`);

    // Get the commit SHA
    const commitSha = execSync("git rev-parse HEAD", {
      cwd: this.repoPath,
      encoding: "utf-8",
    }).trim();

    // Increment timestamp by 1 hour for next commit
    this.commitTimestamp = new Date(
      this.commitTimestamp.getTime() + 60 * 60 * 1000,
    );

    return { commit: { oid: commitSha } };
  }

  async addFiles(files: Record<string, string | Buffer>): Promise<void> {
    this.ensureInitialized();
    for (const filePath of Object.keys(files)) {
      const dir = join(
        this.repoPath,
        filePath.split("/").slice(0, -1).join("/"),
      );
      if (dir !== this.repoPath) {
        await mkdir(dir, { recursive: true });
      }
    }
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(this.repoPath, filePath);
      if (Buffer.isBuffer(content)) {
        await writeFile(fullPath, content);
      } else {
        await writeFile(fullPath, content, "utf-8");
      }
    }
  }

  /**
   * Creates a series of commits with files
   */
  async createCommits(
    commits: TestCommit[],
  ): Promise<{ commit: { oid: string } }[]> {
    const results: { commit: { oid: string } }[] = [];

    for (const commit of commits) {
      if (commit.branch && commit.branch !== this.currentBranch) {
        await this.switchBranch(commit.branch);
      }

      const result = await this.addFilesAndCommit(commit.files, commit.message);
      results.push(result);
    }

    return results;
  }

  /**
   * Deletes files and commits the deletion
   */
  async deleteFilesAndCommit(
    filePaths: string[],
    commitMessage: string,
  ): Promise<{ commit: { oid: string } }> {
    this.ensureInitialized();

    // Delete files using git rm
    for (const filePath of filePaths) {
      await this.runGitCommand(`rm "${filePath}"`);
    }

    // Commit the deletion
    await this.runGitCommand(`commit -m "${commitMessage}"`);

    // Get the commit SHA
    const commitSha = execSync("git rev-parse HEAD", {
      cwd: this.repoPath,
      encoding: "utf-8",
    }).trim();

    // Increment timestamp by 1 hour for next commit
    this.commitTimestamp = new Date(
      this.commitTimestamp.getTime() + 60 * 60 * 1000,
    );

    return { commit: { oid: commitSha } };
  }

  /**
   * Gets the current branch name
   */
  getCurrentBranch(): string {
    return this.currentBranch;
  }

  /**
   * Gets the repository path
   */
  getRepoPath(): string {
    return this.repoPath;
  }

  /**
   * Gets the full absolute path to the repository
   */
  getFullPath(): string {
    return this.repoPath;
  }

  /**
   * Gets the git directory path
   */
  getGitPath(): string {
    return join(this.repoPath, ".git");
  }

  /**
   * Checks if the repository has been initialized
   */
  isRepoInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Ensures the repository is initialized before running Git operations
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error("Repository not initialized. Call createRepo() first.");
    }
  }

  /**
   * Resets the repository to a clean state
   * This will clean up the existing repo and create a fresh one
   */
  async resetRepo(): Promise<void> {
    await this.cleanup();
    await this.createRepo();
  }

  /**
   * Runs a git command in the test repository
   */
  private async runGitCommand(command: string): Promise<void> {
    try {
      const timestamp = this.commitTimestamp.toISOString();
      execSync(`git ${command}`, {
        cwd: this.repoPath,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_DATE: timestamp,
        },
      });
    } catch (error) {
      throw new Error(`Git command failed: git ${command}\nError: ${error}`);
    }
  }

  /**
   * Cleans up the test repository
   */
  async cleanup(): Promise<void> {
    if (existsSync(this.repoPath)) {
      await rm(this.repoPath, { recursive: true, force: true });
    }
  }

  /**
   * Gets the git log as a string
   */
  async getGitLog(): Promise<string> {
    try {
      return execSync("git log --oneline", {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } catch {
      return "Failed to get git log";
    }
  }

  /**
   * Gets the current status
   */
  async getStatus(): Promise<string> {
    try {
      return execSync("git status", {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } catch {
      return "Failed to get git status";
    }
  }

  /**
   * Merges a branch into the current branch
   */
  async mergeBranch(
    branchName: string,
    commitMessage?: string,
  ): Promise<{ commit: { oid: string } }> {
    this.ensureInitialized();
    const message = commitMessage || `Merge branch '${branchName}'`;
    await this.runGitCommand(`merge ${branchName} -m "${message}"`);

    const commitSha = execSync("git rev-parse HEAD", {
      cwd: this.repoPath,
      encoding: "utf-8",
    }).trim();

    // Increment timestamp by 1 hour for next commit
    this.commitTimestamp = new Date(
      this.commitTimestamp.getTime() + 60 * 60 * 1000,
    );

    return { commit: { oid: commitSha } };
  }

  /**
   * Gets the merge base between two refs using git merge-base --all
   * This is used to verify our implementation against git's native implementation
   */
  async getMergeBase(ref1: string, ref2: string): Promise<string[]> {
    try {
      const result = execSync(`git merge-base --all ${ref1} ${ref2}`, {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
      return result
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }
}

/**
 * Factory function to create a test repository with common setup
 */
export async function createTestRepo(
  repoName: string,
  initialFiles: Record<string, string> = {},
): Promise<GitTestHelper> {
  const helper = new GitTestHelper(repoName);
  await helper.createRepo();

  if (Object.keys(initialFiles).length > 0) {
    await helper.addFilesAndCommit(initialFiles, "Initial files");
  }

  return helper;
}

/**
 * Creates a simple test repository with some sample content
 */
export async function createSampleRepo(
  repoName: string,
): Promise<GitTestHelper> {
  const helper = new GitTestHelper(repoName);
  await helper.createRepo();

  // Add some sample files
  const sampleFiles: Record<string, string> = {
    "README.md":
      "# Test Repository\n\nThis is a test repository for testing purposes.",
    "src/index.ts": "export function hello() {\n  return 'Hello, World!';\n}",
    "package.json": JSON.stringify(
      {
        name: "test-repo",
        version: "1.0.0",
        main: "src/index.ts",
      },
      null,
      2,
    ),
  };

  await helper.addFilesAndCommit(sampleFiles, "Add sample files");

  // Create a feature branch
  await helper.createBranch("feature/new-feature");

  const featureFiles: Record<string, string> = {
    "src/feature.ts":
      "export function newFeature() {\n  return 'New feature!';\n}",
  };

  await helper.addFilesAndCommit(featureFiles, "Add new feature");

  // Switch back to main
  await helper.switchBranch("main");

  return helper;
}
