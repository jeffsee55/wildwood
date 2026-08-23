import { createClient, type Client } from "@libsql/client";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBootstrapOwner, listActiveGrants, resolveProject } from "@/nextjs/access";
import { renderCmsDatabasePage } from "@/nextjs/cms-database-page";
import { LibsqlDatabase } from "@/sqlite/database";

const EXPECTED_TABLES = [
  "_blobs",
  "_commits",
  "_refs",
  "_trees",
  "account",
  "connections",
  "deviceCode",
  "entries",
  "filters",
  "jwks",
  "oauthAccessToken",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthConsent",
  "oauthRefreshToken",
  "oauthResource",
  "session",
  "user",
  "verification",
  "wildwood_access_grant",
  "wildwood_approval_request",
  "wildwood_auth_event",
  "wildwood_auth_setting",
  "wildwood_credential",
  "wildwood_project",
  "wildwood_work_intent",
];

describe("generated database schema", () => {
  let client: Client;
  let db: LibsqlDatabase;

  beforeEach(() => {
    client = createClient({ url: ":memory:" });
    db = new LibsqlDatabase({ client, config: {} as never });
  });

  afterEach(() => client.close());

  it("initializes every core, Better Auth, and managed-access table idempotently", async () => {
    await db.init();
    await db.init();

    const result = await client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    );
    expect(result.rows.map((row) => String(row.name))).toEqual(EXPECTED_TABLES);
  });

  it("preserves required auth columns and managed-access indexes", async () => {
    await db.init();

    const userColumns = await client.execute("pragma table_info('user')");
    const byName = new Map(userColumns.rows.map((row) => [String(row.name), row]));
    expect(byName.get("id")?.notnull).toBe(1);
    expect(byName.get("email")?.notnull).toBe(1);
    expect(byName.get("isAnonymous")?.dflt_value).toBe("0");

    const jwksColumns = await client.execute("pragma table_info('jwks')");
    const jwksNames = new Set(jwksColumns.rows.map((row) => String(row.name)));
    expect(jwksNames.has("alg")).toBe(true);
    expect(jwksNames.has("crv")).toBe(true);

    const indexes = await client.execute(
      "select name from sqlite_master where type = 'index' and name like 'wildwood%' order by name",
    );
    expect(indexes.rows.map((row) => String(row.name))).toEqual(
      expect.arrayContaining([
        "wildwoodAccessGrant_owner_uidx",
        "wildwoodCredential_secretHash_uidx",
        "wildwoodProject_external_uidx",
        "wildwoodProject_name_uidx",
      ]),
    );
  });

  it("includes auth and access data in the prototype reset surface", async () => {
    await client.execute("pragma foreign_keys = on");
    await db.init();
    await client.execute(`insert into "wildwood_auth_setting"
      ("key", "value", "created_at", "updated_at")
      values ('better-auth.secret', 'keep-me', 'now', 'now')`);
    await client.execute(`insert into "user"
      ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      values ('user_1', 'Owner', 'owner@example.com', 1, 'now', 'now')`);
    await client.execute(`insert into "session"
      ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
      values ('session_1', 'later', 'token_1', 'now', 'now', 'user_1')`);
    await client.execute(`insert into "wildwood_project"
      ("id", "provider", "org_name", "repo_name", "config_ref", "created_at", "updated_at")
      values ('project_1', 'github', 'acme', 'docs', 'main', 'now', 'now')`);
    await client.execute(`insert into "wildwood_access_grant"
      ("id", "project_id", "subject_type", "subject_id", "permissions", "ref_selectors",
       "kind", "issued_by", "created_at")
      values ('grant_1', 'project_1', 'user', 'user_1', '[]', '[]', 'owner', 'user_1', 'now')`);
    await client.execute(`insert into "wildwood_access_grant"
      ("id", "project_id", "subject_type", "subject_id", "permissions", "ref_selectors",
       "kind", "issued_by", "parent_grant_id", "created_at")
      values ('grant_2', 'project_1', 'agent', 'agent_1', '[]', '[]', 'agent', 'user_1', 'grant_1', 'now')`);

    await db.clear({ preserveAuthSettings: true });

    const users = await client.execute(`select count(*) as count from "user"`);
    const projects = await client.execute(`select count(*) as count from "wildwood_project"`);
    const grants = await client.execute(`select count(*) as count from "wildwood_access_grant"`);
    const settings = await client.execute(`select "value" from "wildwood_auth_setting"`);
    expect(users.rows[0]?.count).toBe(0);
    expect(projects.rows[0]?.count).toBe(0);
    expect(grants.rows[0]?.count).toBe(0);
    expect(settings.rows[0]?.value).toBe("keep-me");

    await db.clear();
    const clearedSettings = await client.execute(
      `select count(*) as count from "wildwood_auth_setting"`,
    );
    expect(clearedSettings.rows[0]?.count).toBe(0);
  });

  it("reports the owner-facing database snapshot", async () => {
    await db.init();
    await client.execute(`insert into "user"
      ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      values ('user_1', 'Owner', 'owner@example.com', 1, 'now', 'now')`);
    await client.execute(`insert into "_refs"
      ("org_name", "repo_name", "ref", "commit_oid")
      values ('acme', 'docs', 'main', 'commit_1')`);

    expect(await db.stats()).toMatchObject({
      users: 1,
      sessions: 0,
      projects: 0,
      grants: 0,
      refs: 1,
      commits: 0,
      entries: 0,
    });
  });

  it("reports real table-level reset progress", async () => {
    await db.init();
    const progress: Array<{
      phase: string;
      table?: string;
      completed?: number;
      total?: number;
    }> = [];

    await db.reset({ preserveAuthSettings: true, onProgress: (event) => progress.push(event) });

    const clearing = progress.filter((event) => event.phase === "clearing");
    expect(clearing).toHaveLength(EXPECTED_TABLES.length - 1);
    expect(clearing.at(-1)).toMatchObject({
      phase: "clearing",
      completed: EXPECTED_TABLES.length - 1,
      total: EXPECTED_TABLES.length - 1,
    });
    expect(clearing.some((event) => event.table === "wildwood_auth_setting")).toBe(false);
    expect(progress.at(-1)).toEqual({ phase: "initializing" });
  });

  it("renders the standalone database page with an isolated, valid progress client", () => {
    const html = renderCmsDatabasePage({
      endpoint: "/api/wildwood/access/reset",
      project: { org: "acme</script>", repo: "docs" },
      stats: {
        users: 1,
        sessions: 2,
        projects: 3,
        grants: 4,
        credentials: 5,
        approvals: 6,
        workIntents: 0,
        authEvents: 7,
        refs: 8,
        commits: 9,
        entries: 10,
      },
    });
    const inlineScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(html).toContain("This page is served directly by Wildwood");
    expect(html).toContain("application/x-ndjson");
    expect(html).not.toContain("acme</script>");
    expect(inlineScript).toBeTruthy();
    if (!inlineScript) throw new Error("Expected an inline CMS database script");
    expect(() => new Script(inlineScript)).not.toThrow();
  });

  it("reclaims the configured owner after a prototype reset", async () => {
    await db.init();
    const input = {
      provider: "github",
      externalId: "R_docs",
      org: "jeffsee55",
      repo: "wildwood",
      configRef: "main",
    };
    const owner = { id: "github_user_1", email: "jeffsee.55@gmail.com" };
    const firstProject = await resolveProject({ db: client, project: input });
    await ensureBootstrapOwner({
      db: client,
      project: firstProject,
      bootstrap: { owner: owner.email },
      user: owner,
    });

    await db.reset({ preserveAuthSettings: true });

    const secondProject = await resolveProject({ db: client, project: input });
    await ensureBootstrapOwner({
      db: client,
      project: secondProject,
      bootstrap: { owner: owner.email },
      user: owner,
    });
    const grants = await listActiveGrants({
      db: client,
      project: secondProject,
      subjectType: "user",
      subjectId: owner.id,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.kind).toBe("owner");
  });
});
