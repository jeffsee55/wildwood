import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetGitRemoteCache,
  __resetVercelEnvCache,
  getVercelSystemEnv,
  parseGitRemoteUrl,
  resolveIdentity,
  resolveOrg,
  resolveOrigin,
  resolveRef,
  resolveRepo,
} from "@/env";

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetVercelEnvCache();
  __resetGitRemoteCache();
}

describe("env — Vercel system env first-class", () => {
  const clean: Record<string, string | undefined> = {
    VERCEL: undefined,
    VERCEL_ENV: undefined,
    VERCEL_TARGET_ENV: undefined,
    VERCEL_PROJECT_PRODUCTION_URL: undefined,
    VERCEL_BRANCH_URL: undefined,
    VERCEL_URL: undefined,
    VERCEL_GIT_PROVIDER: undefined,
    VERCEL_GIT_REPO_OWNER: undefined,
    VERCEL_GIT_REPO_SLUG: undefined,
    VERCEL_GIT_COMMIT_REF: undefined,
    VERCEL_GIT_COMMIT_SHA: undefined,
    VERCEL_GIT_COMMIT_MESSAGE: undefined,
    VERCEL_GIT_COMMIT_AUTHOR_LOGIN: undefined,
    VERCEL_GIT_PULL_REQUEST_ID: undefined,
    WILDWOOD_GITHUB_ORG: undefined,
    WILDWOOD_GITHUB_REPO: undefined,
    WILDWOOD_ORG: undefined,
    WILDWOOD_REPO: undefined,
    WILDWOOD_DOCS_REF: undefined,
    WILDWOOD_REF: undefined,
    WILDWOOD_INFER_GIT_REMOTE: undefined,
    NEXT_PUBLIC_ORIGIN: undefined,
    ORIGIN: undefined,
  };

  beforeEach(() => setEnv(clean));
  afterEach(() => setEnv(clean));

  describe("parseGitRemoteUrl", () => {
    it("parses git@ SSH", () => {
      expect(parseGitRemoteUrl("git@github.com:jeffsee55/wildwood.git")).toEqual({
        org: "jeffsee55",
        repo: "wildwood",
      });
    });
    it("parses https", () => {
      expect(parseGitRemoteUrl("https://github.com/vercel/next.js")).toEqual({
        org: "vercel",
        repo: "next.js",
      });
    });
    it("returns null for garbage", () => {
      expect(parseGitRemoteUrl("not-a-url")).toBeNull();
    });
  });

  it("resolves org/repo from Vercel system envs when present", () => {
    setEnv({
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_GIT_REPO_OWNER: "vercel",
      VERCEL_GIT_REPO_SLUG: "next.js",
      VERCEL_GIT_COMMIT_REF: "main",
    });
    const v = getVercelSystemEnv();
    expect(v.isVercel).toBe(true);
    expect(v.git.owner).toBe("vercel");
    expect(v.git.slug).toBe("next.js");
    expect(resolveOrg()).toBe("vercel");
    expect(resolveRepo()).toBe("next.js");
    expect(resolveRef()).toBe("main");
  });

  it("explicit WILDWOOD_* wins over Vercel", () => {
    setEnv({
      VERCEL_GIT_REPO_OWNER: "vercel",
      VERCEL_GIT_REPO_SLUG: "next.js",
      WILDWOOD_GITHUB_ORG: "jeffsee55",
      WILDWOOD_GITHUB_REPO: "wildwood",
    });
    expect(resolveOrg()).toBe("jeffsee55");
    expect(resolveRepo()).toBe("wildwood");
  });

  it("explicit arg wins over env", () => {
    setEnv({
      VERCEL_GIT_REPO_OWNER: "vercel",
      WILDWOOD_GITHUB_ORG: "jeffsee55",
    });
    expect(resolveOrg("my-explicit")).toBe("my-explicit");
  });

  it("resolveOrigin prefers NEXT_PUBLIC_ORIGIN then Vercel production URL", () => {
    setEnv({
      VERCEL_PROJECT_PRODUCTION_URL: "my-site.com",
      VERCEL_URL: "preview-xyz.vercel.app",
    });
    expect(resolveOrigin()).toBe("https://my-site.com");

    setEnv({
      NEXT_PUBLIC_ORIGIN: "https://custom.example",
      VERCEL_PROJECT_PRODUCTION_URL: "my-site.com",
    });
    expect(resolveOrigin()).toBe("https://custom.example");
  });

  it("ref falls back to VERCEL_GIT_COMMIT_REF then SHA then main", () => {
    setEnv({ VERCEL_GIT_COMMIT_SHA: "abcd1234" });
    expect(resolveRef()).toBe("abcd1234");
    setEnv({ VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_COMMIT_SHA: "abcd1234" });
    expect(resolveRef()).toBe("main"); // branch preferred
    setEnv({});
    expect(resolveRef()).toBe("main");
  });

  it("resolveIdentity aggregates everything", () => {
    setEnv({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_GIT_REPO_OWNER: "acme",
      VERCEL_GIT_REPO_SLUG: "docs",
      VERCEL_GIT_COMMIT_REF: "feat/cms",
      VERCEL_BRANCH_URL: "acme-docs-git-feat-cms.vercel.app",
    });
    const id = resolveIdentity();
    expect(id.org).toBe("acme");
    expect(id.repo).toBe("docs");
    expect(id.ref).toBe("feat/cms");
    expect(id.isVercel).toBe(true);
    expect(id.origin).toBe("https://acme-docs-git-feat-cms.vercel.app");
  });
});
