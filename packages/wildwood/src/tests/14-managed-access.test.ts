import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeManagedAction,
  createAgentSession,
  createContributorAccess,
  createGrant,
  createMergeApprovalRequest,
  decideApprovalRequest,
  ensureBootstrapOwner,
  listActiveGrants,
  listProjectGrants,
  revokeGrant,
  resolveProject,
  userBranchNamespace,
  verifyAgentSession,
  type WildwoodProject,
} from "@/nextjs/access";
import { createPreviewToken, revokePreviewToken } from "@/nextjs/handlers/preview-token";

const project: WildwoodProject = {
  id: "project_docs",
  provider: "github",
  org: "acme",
  repo: "docs",
  configRef: "main",
};

describe("managed ref access", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(`create table "wildwood_project" (
      "id" text not null primary key, "provider" text not null, "external_id" text,
      "org_name" text not null, "repo_name" text not null, "config_ref" text not null,
      "created_at" date not null, "updated_at" date not null,
      unique ("provider", "org_name", "repo_name")
    )`);
    await db.execute({
      sql: `insert into "wildwood_project"
        ("id", "provider", "org_name", "repo_name", "config_ref", "created_at", "updated_at")
        values (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        project.id,
        project.provider,
        project.org,
        project.repo,
        project.configRef,
        "now",
        "now",
      ],
    });
    await db.execute(`create table "wildwood_access_grant" (
      "id" text not null primary key, "project_id" text not null,
      "subject_type" text not null, "subject_id" text not null, "permissions" text not null,
      "ref_selectors" text not null, "constraints" text, "kind" text not null,
      "issued_by" text not null, "parent_grant_id" text, "created_at" date not null,
      "expires_at" date, "revoked_at" date, "uses_remaining" integer
    )`);
    await db.execute(`create table "wildwood_auth_event" (
      "id" text not null primary key, "project_id" text not null,
      "type" text not null, "actor_id" text, "subject_id" text, "grant_id" text,
      "created_at" date not null, "metadata" text
    )`);
    await db.execute(`create table "wildwood_credential" (
      "id" text not null primary key, "project_id" text not null,
      "kind" text not null, "subject_type" text not null, "subject_id" text not null,
      "grant_id" text, "secret_hash" text unique, "created_at" date not null,
      "expires_at" date, "revoked_at" date
    )`);
    await db.execute(`create table "wildwood_approval_request" (
      "id" text not null primary key, "project_id" text not null,
      "requested_by" text not null, "permission" text not null, "source_ref" text not null,
      "target_ref" text not null, "source_commit" text not null, "reason" text,
      "status" text not null, "created_at" date not null, "expires_at" date not null,
      "decided_at" date, "decided_by" text, "grant_id" text
    )`);
    await db.execute(`create table "user" (
      "id" text not null primary key, "name" text not null, "email" text not null unique,
      "emailVerified" integer not null, "isAnonymous" integer default 0,
      "createdAt" date not null, "updatedAt" date not null
    )`);
    await db.execute(`create table "verification" (
      "id" text not null primary key, "identifier" text not null, "value" text not null,
      "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null
    )`);
  });

  afterEach(() => db.close());

  it("keeps stable, isolated project identities across repository renames", async () => {
    const blog = await resolveProject({
      db,
      project: {
        provider: "github",
        externalId: "R_blog",
        org: "acme",
        repo: "blog",
        configRef: "main",
      },
    });
    const renamed = await resolveProject({
      db,
      project: {
        provider: "github",
        externalId: "R_blog",
        org: "new-acme",
        repo: "website",
        configRef: "production",
      },
    });
    expect(renamed.id).toBe(blog.id);
    expect(renamed).toMatchObject({
      org: "new-acme",
      repo: "website",
      configRef: "production",
    });

    await createContributorAccess({ db, project, userId: "u_123", issuedBy: "u_owner" });
    await expect(
      authorizeManagedAction({
        db,
        project: renamed,
        user: { id: "u_123" },
        action: { type: "content.read", ref: "main" },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("bootstraps the configured owner exactly once", async () => {
    const user = { id: "u_owner", email: "owner@example.com" };
    await ensureBootstrapOwner({
      db,
      project,
      bootstrap: { owner: "OWNER@example.com" },
      user,
    });
    await ensureBootstrapOwner({
      db,
      project,
      bootstrap: { owner: "owner@example.com" },
      user,
    });

    const grants = await listActiveGrants({
      db,
      project,
      subjectType: "user",
      subjectId: user.id,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.kind).toBe("owner");
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.merge", ref: "users/u_other/change" },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("gives contributors main read plus control of only their namespace", async () => {
    const user = { id: "u_123", email: "contributor@example.com" };
    await createContributorAccess({
      db,
      project,
      userId: user.id,
      issuedBy: "u_owner",
    });
    const ownRef = `${userBranchNamespace(user.id)}rewrite-homepage`;

    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "content.read", ref: "main" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.createBranch", name: ownRef, baseRef: "main" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.commit", ref: ownRef, message: "Update page" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.commit", ref: "main", message: "No" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.createBranch", name: "users/u_other/escape", baseRef: "main" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.merge", ref: ownRef },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("provisions contributor access idempotently and records grant events", async () => {
    const first = await createContributorAccess({
      db,
      project,
      userId: "u_123",
      issuedBy: "u_owner",
    });
    const second = await createContributorAccess({
      db,
      project,
      userId: "u_123",
      issuedBy: "u_owner",
    });

    expect(second.base.id).toBe(first.base.id);
    expect(second.namespace.id).toBe(first.namespace.id);
    const grants = await db.execute(
      `select "id" from "wildwood_access_grant" where "subject_id" = 'u_123'`,
    );
    const events = await db.execute(
      `select "grant_id" from "wildwood_auth_event" where "type" = 'grant.created'`,
    );
    expect(grants.rows).toHaveLength(2);
    expect(events.rows).toHaveLength(2);
  });

  it("applies revocation on the next authorization check", async () => {
    const user = { id: "u_123", email: "contributor@example.com" };
    const grants = await createContributorAccess({
      db,
      project,
      userId: user.id,
      issuedBy: "u_owner",
    });
    const ref = `${userBranchNamespace(user.id)}draft`;

    await revokeGrant({ db, project, grantId: grants.namespace.id, actorId: "u_owner" });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user,
        action: { type: "git.commit", ref, message: "Denied" },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("issues exact-ref agent credentials and cascades parent revocation", async () => {
    const user = { id: "u_123", email: "contributor@example.com" };
    const contributor = await createContributorAccess({
      db,
      project,
      userId: user.id,
      issuedBy: "u_owner",
    });
    const ref = `${userBranchNamespace(user.id)}agent-edit`;
    const session = await createAgentSession({ db, project, user, ref, ttlSeconds: 300 });

    expect(session.token).toMatch(/^wwa_/);
    expect(session.grant.refs).toEqual([{ type: "exact", ref }]);
    await expect(verifyAgentSession({ db, project, token: session.token })).resolves.toMatchObject({
      agentId: session.agentId,
    });
    const otherProject = await resolveProject({
      db,
      project: {
        provider: "github",
        externalId: "R_other",
        org: "acme",
        repo: "other",
        configRef: "main",
      },
    });
    await expect(
      verifyAgentSession({ db, project: otherProject, token: session.token }),
    ).resolves.toBeNull();
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: session.agentId, managedSubjectType: "agent" },
        action: { type: "git.commit", ref, message: "Agent edit" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: session.agentId, managedSubjectType: "agent" },
        action: { type: "git.commit", ref: `${ref}-other`, message: "Escape" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: session.agentId, managedSubjectType: "agent" },
        action: { type: "git.merge", ref },
      }),
    ).resolves.toMatchObject({ allowed: false });

    await revokeGrant({
      db,
      project,
      grantId: contributor.namespace.id,
      actorId: "u_owner",
    });
    await expect(verifyAgentSession({ db, project, token: session.token })).resolves.toBeNull();
  });

  it("binds an approved agent merge to its branch and source commit", async () => {
    const user = { id: "u_123", email: "contributor@example.com" };
    const contributor = await createContributorAccess({
      db,
      project,
      userId: user.id,
      issuedBy: "u_owner",
    });
    const ref = `${userBranchNamespace(user.id)}ready`;
    const session = await createAgentSession({ db, project, user, ref });
    const approval = await createMergeApprovalRequest({
      db,
      project,
      requestedBy: session.agentId,
      sourceRef: ref,
      sourceCommit: "commit_a",
    });
    await decideApprovalRequest({
      db,
      project,
      approvalId: approval.id,
      actorId: "u_owner",
      decision: "approve",
    });

    const agent = { id: session.agentId, managedSubjectType: "agent" as const };
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: agent,
        action: { type: "git.merge", ref, sourceCommit: "commit_a" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: agent,
        action: { type: "git.merge", ref, sourceCommit: "commit_a" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: agent,
        action: { type: "git.merge", ref, sourceCommit: "commit_b" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: agent,
        action: { type: "git.merge", ref: `${ref}-other`, sourceCommit: "commit_a" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await revokeGrant({
      db,
      project,
      grantId: contributor.namespace.id,
      actorId: "u_owner",
    });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: agent,
        action: { type: "git.merge", ref, sourceCommit: "commit_a" },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("isolates anonymous preview authority per link", async () => {
    const ref = "users/u_owner/share";
    const parent = await createGrant({
      db,
      project,
      grant: {
        subjectType: "user",
        subjectId: "u_owner",
        permissions: ["branch.share"],
        refs: [{ type: "exact", ref }],
        kind: "custom",
        issuedBy: "u_owner",
      },
    });
    const previewDb = { client: db } as never;
    const common = {
      auth: {} as never,
      db: previewDb,
      editor: { id: "u_owner", email: "owner@example.com" },
      branch: ref,
      origin: "https://example.com",
      previewPath: "/api/wildwood/preview",
      access: { db, project, parentGrantId: parent.id },
    };
    const first = await createPreviewToken(common);
    const second = await createPreviewToken(common);
    expect(first.grantId).not.toBe(second.grantId);

    const grants = await listProjectGrants({ db, project });
    const firstGrant = grants.find((grant) => grant.id === first.grantId)!;
    const secondGrant = grants.find((grant) => grant.id === second.grantId)!;
    expect(firstGrant.subjectId).not.toBe(secondGrant.subjectId);

    await revokePreviewToken({
      db: previewDb,
      token: first.token,
      branch: ref,
      access: { db, project, actorId: "u_owner" },
    });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: firstGrant.subjectId, isAnonymous: true },
        action: { type: "content.read", ref },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: secondGrant.subjectId, isAnonymous: true },
        action: { type: "content.read", ref },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("invalidates delegated grants when their parent is revoked", async () => {
    const parent = await createGrant({
      db,
      project,
      grant: {
        subjectType: "user",
        subjectId: "u_owner",
        permissions: ["branch.share"],
        refs: [{ type: "prefix", prefix: "users/u_owner/" }],
        kind: "custom",
        issuedBy: "u_owner",
      },
    });
    await createGrant({
      db,
      project,
      grant: {
        subjectType: "anonymous",
        subjectId: "share_1",
        permissions: ["content.read"],
        refs: [{ type: "exact", ref: "users/u_owner/draft" }],
        kind: "share",
        issuedBy: "u_owner",
        parentGrantId: parent.id,
      },
    });

    expect(
      await listActiveGrants({
        db,
        project,
        subjectType: "anonymous",
        subjectId: "share_1",
      }),
    ).toHaveLength(1);
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: "share_1", isAnonymous: true },
        action: { type: "content.read", ref: "users/u_owner/draft" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await revokeGrant({ db, project, grantId: parent.id, actorId: "u_owner" });
    expect(
      await listActiveGrants({
        db,
        project,
        subjectType: "anonymous",
        subjectId: "share_1",
      }),
    ).toHaveLength(0);
    await expect(
      authorizeManagedAction({
        db,
        project,
        user: { id: "share_1", isAnonymous: true },
        action: { type: "content.read", ref: "users/u_owner/draft" },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
