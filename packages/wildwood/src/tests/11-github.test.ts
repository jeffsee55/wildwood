import { createClient as libsqlCreateClient } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "@/client/config";
import { createClient } from "@/client/index";
import { z } from "@/index";
import { LibsqlDatabase } from "@/sqlite/database";
import { GitHubTestHelper } from "@/tests/_github-test-helper";
import { url } from "../../drizzle.sqlite.js";

const authors = z.collection({
  name: "authors",
  match: "content/authors/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
  }),
});

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    author: z.connect(authors, { referencedAs: "docsAuthored" }),
  }),
});

describe("github remote", () => {
  const helper = new GitHubTestHelper("tr33-github-remote");
  const libsqlClient = libsqlCreateClient({ url: url });

  function makeClient() {
    const config = defineConfig({
      org: helper.getOwner(),
      repo: helper.getRepoName(),
      ref: "main",
      collections: { docs, authors },
    });
    return createClient({ config, database: libsqlClient });
  }

  beforeAll(async () => {
    await helper.createRepo();
    await helper.addFilesAndCommit(
      {
        "content/docs/getting-started.md":
          "---\ntitle: Getting Started\n---\n\n# Getting Started",
        "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
      },
      "Initial commit",
    );
    await helper.addFilesAndCommit(
      {
        "content/docs/new-page.md": "---\ntitle: New Page\n---\n\n# New Page",
      },
      "Add new page",
    );
    // Create a feature branch for merge tests
    await helper.createBranch("feature");
    await helper.addFilesAndCommit(
      {
        "content/docs/feature-page.md":
          "---\ntitle: Feature Page\n---\n\n# Feature Page",
      },
      "Add feature page",
    );
    await helper.switchBranch("main");
  }, 30_000);

  beforeEach(async () => {
    const config = defineConfig({
      org: helper.getOwner(),
      repo: helper.getRepoName(),
      ref: "main",
      collections: { docs, authors },
    });
    const db = new LibsqlDatabase({ client: libsqlClient, config });
    await db.reset();
  });

  afterAll(async () => {
    // await helper.cleanup();
    await helper.reportRateLimit();
  }, 15_000);

  it("switch fetches content from github", async () => {
    const client = makeClient();
    await client._.git.switch({ ref: "main" });

    const result = await client.docs.findMany({
      where: { title: { eq: "Getting Started" } },
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.title).toBe("Getting Started");
  }, 30_000);

  it("switch fetches all content including later commits", async () => {
    const client = makeClient();
    await client._.git.switch({ ref: "main" });

    const result = await client.docs.findMany({
      where: { title: { eq: "New Page" } },
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.title).toBe("New Page");
  }, 30_000);

  it("push sends local commit to github", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });
    await git.add({
      ref: "main",
      files: {
        "content/docs/pushed-page.md":
          "---\ntitle: Pushed Page\n---\n\n# Pushed Page",
      },
    });
    await git.commit({
      ref: "main",
      commit: {
        message: "Add pushed page",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    const localCommit = await client._.db.refs.get({ ref: "main" });
    expect(localCommit?.commit.oid).toBeDefined();

    const result = await git.push({ ref: "main" });

    // Verify the tree on GitHub matches what we pushed
    // Fetch by commit OID (not ref) to avoid GitHub API caching on ref resolution
    const remoteCommitByOid = await git.remote.fetchCommit({
      oid: result.commitOid,
    });
    expect(remoteCommitByOid.treeOid).toBe(result.treeOid);

    // Also verify the ref points to our commit
    const remoteCommitByRef = await git.remote.fetchCommit({ ref: "main" });
    if (remoteCommitByRef.oid !== result.commitOid) {
      console.warn(
        `Ref resolution stale: ref "main" points to ${remoteCommitByRef.oid}, expected ${result.commitOid} (tree: ${remoteCommitByRef.treeOid} vs ${result.treeOid})`,
      );
    }
    expect(remoteCommitByRef.oid).toBe(result.commitOid);

    if (!localCommit) {
      throw new Error(`Local commit not found`);
    }

    // Verify the commit was marked as pushed locally
    const commitOid = localCommit.commit.oid;
    const raw = await client._.db.commits.getRaw({ oid: commitOid });
    if (raw) {
      expect(raw.pushedAt).toBeTypeOf("number");
      expect(raw.pushedAt).toBeGreaterThan(0);
    } else {
      throw new Error(`Commit ${commitOid} not found`);
    }
  }, 60_000);

  it("push sends multiple unpushed commits to github", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });

    // Create first local commit (not pushed)
    await git.add({
      ref: "main",
      files: {
        "content/docs/multi-1.md":
          "---\ntitle: Multi 1\n---\n\n# First unpushed commit",
      },
    });
    const commit1 = await git.commit({
      ref: "main",
      commit: {
        message: "Add multi-1",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    // Create second local commit (not pushed)
    await git.add({
      ref: "main",
      files: {
        "content/docs/multi-2.md":
          "---\ntitle: Multi 2\n---\n\n# Second unpushed commit",
      },
    });
    const commit2 = await git.commit({
      ref: "main",
      commit: {
        message: "Add multi-2",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    // Create third local commit (not pushed)
    await git.add({
      ref: "main",
      files: {
        "content/docs/multi-3.md":
          "---\ntitle: Multi 3\n---\n\n# Third unpushed commit",
      },
    });
    const commit3 = await git.commit({
      ref: "main",
      commit: {
        message: "Add multi-3",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    // None should be pushed yet
    const raw1Before = await client._.db.commits.getRaw({
      oid: commit1.oid,
    });
    const raw2Before = await client._.db.commits.getRaw({
      oid: commit2.oid,
    });
    const raw3Before = await client._.db.commits.getRaw({
      oid: commit3.oid,
    });
    expect(raw1Before?.pushedAt).toBeNull();
    expect(raw2Before?.pushedAt).toBeNull();
    expect(raw3Before?.pushedAt).toBeNull();

    // Push all three at once
    const result = await git.push({ ref: "main" });

    // Should have pushed 3 commits
    expect(result.commitOidMap.size).toBe(3);

    // Verify all three are marked pushed locally
    const raw1After = await client._.db.commits.getRaw({
      oid: commit1.oid,
    });
    const raw2After = await client._.db.commits.getRaw({
      oid: commit2.oid,
    });
    const raw3After = await client._.db.commits.getRaw({
      oid: commit3.oid,
    });
    expect(raw1After?.pushedAt).toBeTypeOf("number");
    expect(raw2After?.pushedAt).toBeTypeOf("number");
    expect(raw3After?.pushedAt).toBeTypeOf("number");

    // Verify the final commit on GitHub has the right tree
    const remoteCommit = await git.remote.fetchCommit({
      oid: result.commitOid,
    });
    expect(remoteCommit.treeOid).toBe(result.treeOid);

    // Verify the ref points to the last commit
    const remoteRef = await git.remote.fetchCommit({ ref: "main" });
    expect(remoteRef.oid).toBe(result.commitOid);

    // Verify all three pages are visible by switching from a fresh DB
    const config2 = defineConfig({
      org: helper.getOwner(),
      repo: helper.getRepoName(),
      ref: "main",
      collections: { docs, authors },
    });
    const db2 = new LibsqlDatabase({ client: libsqlClient, config: config2 });
    await db2.reset();
    const client2 = createClient({ config: config2, database: libsqlClient });
    await client2._.git.switch({ ref: "main" });

    for (const title of ["Multi 1", "Multi 2", "Multi 3"]) {
      const found = await client2.docs.findMany({
        where: { title: { eq: title } },
      });
      expect(found.items.length).toBe(1);
      expect(found.items[0]?.title).toBe(title);
    }
  }, 90_000);

  it("push after local merge traverses both parents", async () => {
    const client = makeClient();
    const git = client._.git;

    // Switch to both branches to get their remote state
    await git.switch({ ref: "main" });
    await git.switch({ ref: "feature" });

    // Make a local commit on main (diverging from remote)
    await git.add({
      ref: "main",
      files: {
        "content/docs/main-only.md":
          "---\ntitle: Main Only\n---\n\n# Main Only",
      },
    });
    const mainCommit = await git.commit({
      ref: "main",
      commit: {
        message: "Add main-only page",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    // Make a local commit on feature (diverging from remote)
    await git.add({
      ref: "feature",
      files: {
        "content/docs/feature-only.md":
          "---\ntitle: Feature Only\n---\n\n# Feature Only",
      },
    });
    const featureCommit = await git.commit({
      ref: "feature",
      commit: {
        message: "Add feature-only page",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    // Merge feature into main (non-fast-forward — both branches diverged)
    const mergeResult = await git.merge({
      ours: "main",
      theirs: "feature",
    });
    expect(mergeResult.type).toBe("success");
    if (mergeResult.type !== "success") throw new Error("Merge failed");

    const mergeCommit = mergeResult.commit;
    expect(mergeCommit.parent).toBe(mainCommit.oid);
    expect(mergeCommit.secondParent).toBe(featureCommit.oid);

    // Update the ref to point to the merge commit
    await client._.db.refs.updateCommit({
      ref: "main",
      commit: mergeCommit,
    });

    // Push main — should include mainCommit, featureCommit, and mergeCommit
    const result = await git.push({ ref: "main" });

    expect(result.commitOidMap.size).toBe(3);

    // All three commits should be marked as pushed
    for (const oid of [mainCommit.oid, featureCommit.oid, mergeCommit.oid]) {
      const raw = await client._.db.commits.getRaw({ oid });
      expect(raw?.pushedAt).toBeTypeOf("number");
    }

    // Verify the remote has the merge commit with correct tree
    const remoteCommit = await git.remote.fetchCommit({
      oid: result.commitOid,
    });
    expect(remoteCommit.treeOid).toBe(result.treeOid);

    // The remote merge commit should have 2 parents
    const remoteParents = [
      remoteCommit.parent,
      remoteCommit.secondParent,
    ].filter(Boolean);
    expect(remoteParents.length).toBe(2);

    // Verify the ref is updated
    const remoteRef = await git.remote.fetchCommit({ ref: "main" });
    expect(remoteRef.oid).toBe(result.commitOid);

    // Verify all content is visible from a fresh switch
    const config2 = defineConfig({
      org: helper.getOwner(),
      repo: helper.getRepoName(),
      ref: "main",
      collections: { docs, authors },
    });
    const db2 = new LibsqlDatabase({ client: libsqlClient, config: config2 });
    await db2.reset();
    const client2 = createClient({ config: config2, database: libsqlClient });
    await client2._.git.switch({ ref: "main" });

    for (const title of ["Main Only", "Feature Only"]) {
      const found = await client2.docs.findMany({
        where: { title: { eq: title } },
      });
      expect(found.items.length).toBe(1);
      expect(found.items[0]?.title).toBe(title);
    }
  }, 90_000);

  /**
   * Helper: create a local branch ref from main and switch to it.
   * The base commit (from main) is already marked as pushed,
   * so new commits on this branch will be the only unpushed ones.
   */
  async function createLocalBranch(
    client: ReturnType<typeof makeClient>,
    branchRef: string,
  ) {
    const mainRef = await client._.db.refs.get({ ref: "main" });
    if (!mainRef) throw new Error("main ref not found");
    await client._.db.refs.updateRemoteCommit({
      ref: branchRef,
      commit: mainRef.commit,
    });
    await client._.git.switch({ ref: branchRef });
  }

  it("push creates a PR when pr option is provided", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });
    const branchRef = "pr-test-create";
    await createLocalBranch(client, branchRef);

    await git.add({
      ref: branchRef,
      files: {
        "content/docs/pr-page.md": "---\ntitle: PR Page\n---\n\n# PR Page",
      },
    });
    await git.commit({
      ref: branchRef,
      commit: {
        message: "Add PR page",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    const result = await git.push({
      ref: branchRef,
      pr: {
        title: "Test PR",
        body: "This is a test pull request",
        labels: ["test-label"],
      },
    });

    expect(result.pr).toBeDefined();
    expect(result.pr?.number).toBeTypeOf("number");
    expect(result.pr?.url).toContain("github.com");
  }, 60_000);

  it("push skips PR when ref is the config ref", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });

    await git.add({
      ref: "main",
      files: {
        "content/docs/no-pr-page.md":
          "---\ntitle: No PR Page\n---\n\n# No PR Page",
      },
    });
    await git.commit({
      ref: "main",
      commit: {
        message: "Add no-pr page",
        author: { name: "Test", email: "test@test.com" },
      },
    });

    const result = await git.push({
      ref: "main",
      pr: {
        title: "Should not be created",
        body: "This PR should be skipped",
      },
    });

    expect(result.pr).toBeUndefined();
  }, 60_000);

  it("push updates existing PR with new title/body/labels", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });
    const branchRef = "pr-test-update";
    await createLocalBranch(client, branchRef);

    // First push — creates the PR
    await git.add({
      ref: branchRef,
      files: {
        "content/docs/update-1.md": "---\ntitle: Update 1\n---\n\n# Update 1",
      },
    });
    await git.commit({
      ref: branchRef,
      commit: {
        message: "Add update-1",
        author: { name: "Test", email: "test@test.com" },
      },
    });
    const result1 = await git.push({
      ref: branchRef,
      pr: {
        title: "Original Title",
        body: "Original body",
        labels: ["v1"],
      },
    });
    expect(result1.pr).toBeDefined();
    if (!result1.pr) throw new Error("PR not created");
    expect(result1.pr.title).toBe("Original Title");
    expect(result1.pr.body).toBe("Original body");

    // Second push — updates the existing PR with new static values
    await git.add({
      ref: branchRef,
      files: {
        "content/docs/update-2.md": "---\ntitle: Update 2\n---\n\n# Update 2",
      },
    });
    await git.commit({
      ref: branchRef,
      commit: {
        message: "Add update-2",
        author: { name: "Test", email: "test@test.com" },
      },
    });
    const result2 = await git.push({
      ref: branchRef,
      pr: {
        title: "Updated Title",
        body: "Updated body",
        labels: ["v2"],
      },
    });

    expect(result2.pr).toBeDefined();
    expect(result2.pr?.number).toBe(result1.pr.number);
    expect(result2.pr?.title).toBe("Updated Title");
    expect(result2.pr?.body).toBe("Updated body");
    expect(result2.pr?.labels).toContain("v2");
  }, 90_000);

  it("push updates PR using callbacks for title/body/labels", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });
    const branchRef = "pr-test-callback";
    await createLocalBranch(client, branchRef);

    // First push — creates the PR
    await git.add({
      ref: branchRef,
      files: {
        "content/docs/cb-1.md": "---\ntitle: CB 1\n---\n\n# CB 1",
      },
    });
    await git.commit({
      ref: branchRef,
      commit: {
        message: "Add cb-1",
        author: { name: "Test", email: "test@test.com" },
      },
    });
    const result1 = await git.push({
      ref: branchRef,
      pr: {
        title: "Callback PR",
        body: "Line 1",
      },
    });
    expect(result1.pr).toBeDefined();
    if (!result1.pr) throw new Error("PR not created");

    // Second push — uses callbacks to append to existing values
    await git.add({
      ref: branchRef,
      files: {
        "content/docs/cb-2.md": "---\ntitle: CB 2\n---\n\n# CB 2",
      },
    });
    await git.commit({
      ref: branchRef,
      commit: {
        message: "Add cb-2",
        author: { name: "Test", email: "test@test.com" },
      },
    });
    const result2 = await git.push({
      ref: branchRef,
      pr: {
        title: (prev) => `${prev} (updated)`,
        body: (prev) => `${prev}\nLine 2`,
        labels: (prev) => [...prev, "new-label"],
      },
    });

    expect(result2.pr).toBeDefined();
    expect(result2.pr?.number).toBe(result1.pr.number);
    expect(result2.pr?.title).toBe("Callback PR (updated)");
    expect(result2.pr?.body).toBe("Line 1\nLine 2");
    expect(result2.pr?.labels).toContain("new-label");
  }, 90_000);

  it("mergePr merges the PR and pull fetches the result", async () => {
    const client = makeClient();
    const git = client._.git;

    await git.switch({ ref: "main" });
    const branchRef = "pr-test-merge";
    await createLocalBranch(client, branchRef);

    await git.add({
      ref: branchRef,
      files: {
        "content/docs/merge-pr-page.md":
          "---\ntitle: Merge PR Page\n---\n\n# Merge PR Page",
      },
    });
    await git.commit({
      ref: branchRef,
      commit: {
        message: "Add merge-pr page",
        author: { name: "Test", email: "test@test.com" },
      },
    });
    const pushResult = await git.push({
      ref: branchRef,
      pr: {
        title: "PR to merge",
        body: "Will be merged in this test",
      },
    });
    expect(pushResult.pr).toBeDefined();
    if (!pushResult.pr) throw new Error("PR not created");

    // Merge the PR on GitHub
    const mergeResult = await git.remote.mergePr({
      pr: pushResult.pr.number,
      method: "squash",
    });
    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.commitOid).toBeDefined();

    // Pull the merge result into a fresh local state
    const config2 = defineConfig({
      org: helper.getOwner(),
      repo: helper.getRepoName(),
      ref: "main",
      collections: { docs, authors },
    });
    const db2 = new LibsqlDatabase({ client: libsqlClient, config: config2 });
    await db2.reset();
    const client2 = createClient({ config: config2, database: libsqlClient });
    await client2._.git.switch({ ref: "main" });

    const found = await client2.docs.findMany({
      where: { title: { eq: "Merge PR Page" } },
    });
    expect(found.items.length).toBe(1);
    expect(found.items[0]?.title).toBe("Merge PR Page");
  }, 90_000);
});
