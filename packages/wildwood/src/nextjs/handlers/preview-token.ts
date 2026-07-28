/**
 * `wildwood/nextjs/handlers/preview-token`
 *
 * Per-branch preview sharing tokens — "share a link that swaps a url with an
 * access token". Lets an editor generate a single short-lived, read-only link
 * scoped to one branch, and hand it to multiple visitors who do NOT need a
 * real account.
 *
 * ## How it works
 *
 * Each branch maps to its own "god-user" (an anonymous better-auth user with
 * `isAnonymous: true`). The branch identity is encoded in the user's email as a
 * stable, derivable slug:
 *
 *   branch: feat/add-auth      → user: preview-branch-feat-add-auth@wildwood.local
 *   branch: agent/mcp-tools    → user: preview-branch-agent-mcp-tools@wildwood.local
 *
 * Two completely separate users → two completely separate session pools → no
 * cross-contamination between branches. Revoking one branch's link / sessions
 * does not affect other branches.
 *
 * ## Persistence
 *
 * - **Branch god-user**: a `user` row with `isAnonymous = true`. Created on
 *   first preview-token request for a branch; reused on subsequent requests. One
 *   row per branch — stable, findable by email.
 * - **Capability token**: a `verification` row (`identifier:
 *   preview-token:<random>`, `value: { branch, scope: "read" }`, `expiresAt`).
 *   One row per link. Verifiable by identifier.
 * - **Visitor sessions**: normal `session` rows, each linked to the branch
 *   god-user's `id`. One row per visitor (each opens the link → new session).
 *
 * All three use existing better-auth tables — no migrations needed.
 *
 * ## Flow
 *
 * Editor (signed-in real user):
 *   POST /api/wildwood/preview-token?branch=feat/add-auth
 *     → find-or-create god-user for branch
 *     → mint capability token (verification row)
 *     → returns { url: https://<host>/preview?branch=&token= }
 *
 * Visitor (no account):
 *   GET  /api/wildwood/preview?branch=feat/add-auth&token=<random>
 *     → verify token (not expired, not revoked)
 *     → sign in anonymously under the branch god-user
 *     → set session cookie + branch cookie
 *     → redirect to "/" so the preview renders
 *
 * Revocation:
 *   DELETE /api/wildwood/preview-token?token=<random>  → delete verification row
 *   Future link visits fail (token gone); existing sessions can be nuked via
 *   revokeSessions({ userId: <branch-god-user-id> }).
 */

import type { WildwoodClient } from "@/client/index";
import type { WildwoodAuthInstance, WildwoodAuthUser } from "@/nextjs/auth";
import { NextResponse } from "next/server";

/** Prefix for the branch god-user emails. */
const PREVIEW_USER_EMAIL_PREFIX = "preview-branch-";
/** Domain for the branch god-user emails. Not a real mailbox. */
const PREVIEW_USER_EMAIL_DOMAIN = "wildwood.local";
/** Prefix for capability tokens in the `verification` table. */
const PREVIEW_TOKEN_IDENTIFIER_PREFIX = "preview-token:";
/** Default token expiry: 7 days in seconds. */
const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;
/** Default session expiry for preview visitors: 7 days in seconds. */
const DEFAULT_SESSION_TTL_SEC = 7 * 24 * 60 * 60;

/** Derive the stable "god-user" email for a branch. */
export function previewUserEmailForBranch(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${PREVIEW_USER_EMAIL_PREFIX}${slug}@${PREVIEW_USER_EMAIL_DOMAIN}`;
}

/** Check if an email looks like a branch god-user email. */
export function isPreviewUserEmail(email: string | undefined): boolean {
  if (!email) return false;
  return email.startsWith(PREVIEW_USER_EMAIL_PREFIX) && email.endsWith(`@${PREVIEW_USER_EMAIL_DOMAIN}`);
}

/** Extract the branch name from a branch god-user email, or null. */
export function branchFromPreviewUserEmail(email: string | undefined): string | null {
  if (!isPreviewUserEmail(email)) return null;
  const core = email!.slice(PREVIEW_USER_EMAIL_PREFIX.length, -`@${PREVIEW_USER_EMAIL_DOMAIN}`.length);
  return core.replace(/-/g, "/");
}

/** Generate a random token (URL-safe, 32 bytes). */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += chars[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += chars[b2 & 0x3f];
  }
  return out.slice(0, Math.ceil((bytes.length * 8) / 6));
}

type LibsqlClientLike = { execute(s: string | { sql: string; args: unknown[] }): Promise<unknown> };

export type PreviewTokenResult = {
  token: string;
  url: string;
  branch: string;
  expiresAt: number; // epoch ms
};

/**
 * Create a preview-share token for a branch. Called by the editor endpoint.
 * The caller (route) resolves the authenticated *editor* user — only signed-in
 * non-anonymous users can create tokens.
 */
export async function createPreviewToken(args: {
  auth: WildwoodAuthInstance;
  db: WildwoodClient["_"]["db"];
  editor: WildwoodAuthUser;
  branch: string;
  /** Base origin for the generated URL (e.g. "https://example.com"). */
  origin: string;
  /** Path prefix for the preview route (e.g. "/api/wildwood/preview"). */
  previewPath: string;
  /** Token TTL in seconds. Defaults to 7 days. */
  ttlSec?: number;
}): Promise<PreviewTokenResult> {
  // Only non-anonymous (real) users can create preview tokens.
  if (args.editor.isAnonymous) {
    throw new Error("Anonymous users cannot create preview tokens.");
  }
  const ttlSec = args.ttlSec ?? DEFAULT_TOKEN_TTL_SEC;
  const expiresAt = Date.now() + ttlSec * 1000;

  const email = previewUserEmailForBranch(args.branch);

  // Find-or-create the per-branch god-user. We go through the better-auth API
  // so the user row + isAnonymous flag land in the right place without touching
  // schema internals. If a user with this email already exists (from a prior
  // token for the same branch), we reuse it.
  const godUser = await findOrCreatePreviewUser(args.auth, args.db, email, args.branch);

  // Mint a capability token in the verification table. The identifier is the
  // token itself (prefixed for namespacing). The value carries the branch +
  // scope so the verify path can reconstruct everything from one row.
  const token = randomToken();
  const identifier = `${PREVIEW_TOKEN_IDENTIFIER_PREFIX}${token}`;
  const value = JSON.stringify({ branch: args.branch, scope: "read" });

  await executeSql(args.db, `insert into "verification" ("identifier", "value", "expiresAt", "createdAt", "updatedAt") values (?, ?, ?, ?, ?)`, [
    identifier,
    value,
    new Date(expiresAt).toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
  ]);

  const url = new URL(`${args.origin}${args.previewPath}`);
  url.searchParams.set("branch", args.branch);
  url.searchParams.set("token", token);

  return { token, url: url.toString(), branch: args.branch, expiresAt };
}

/**
 * Verify a preview-share token and mint a session for the branch god-user.
 * Called by the preview route when a visitor opens a share link. Returns the
 * session + branch so the route can set cookies and redirect.
 */
export async function verifyPreviewToken(args: {
  auth: WildwoodAuthInstance;
  db: WildwoodClient["_"]["db"];
  token: string;
}): Promise<{ ok: true; branch: string; setCookie: string } | { ok: false; error: string }> {
  const identifier = `${PREVIEW_TOKEN_IDENTIFIER_PREFIX}${args.token}`;

  // Look up the capability token. We keep it so multiple visitors can open the
  // same link (each mints their own session). Deleting it would break the
  // "share to multiple people" requirement.
  const rows = (await executeSql(
    args.db,
    `select "value", "expiresAt" from "verification" where "identifier" = ?`,
    [identifier],
  )) as { rows?: Array<Record<string, unknown>> };

  const row = rows?.rows?.[0];
  if (!row) return { ok: false, error: "Token not found or revoked." };

  const expiresAtRaw = row.expiresAt;
  let expiresAt: number;
  if (expiresAtRaw instanceof Date) expiresAt = expiresAtRaw.getTime();
  else if (typeof expiresAtRaw === "string") expiresAt = Date.parse(expiresAtRaw);
  else if (typeof expiresAtRaw === "number") expiresAt = expiresAtRaw;
  else expiresAt = 0;

  if (Date.now() > expiresAt) return { ok: false, error: "Token expired." };

  let parsed: { branch?: string; scope?: string };
  try {
    parsed = JSON.parse(String(row.value));
  } catch {
    return { ok: false, error: "Token corrupted." };
  }
  if (!parsed.branch) return { ok: false, error: "Token has no branch." };

  const email = previewUserEmailForBranch(parsed.branch);
  const godUser = await findOrCreatePreviewUser(args.auth, args.db, email, parsed.branch);

  // Mint a session for the god-user. The visitor gets a real better-auth
  // session, scoped to the branch god-user. The session cookie is set by the
  // route via the returned setCookie header.
  const session = await createSessionForUser(args.db, godUser.id, parsed.branch);

  return {
    ok: true,
    branch: parsed.branch,
    setCookie: session.setCookie,
  };
}

/**
 * Revoke a preview-share token by deleting its verification row. Existing
 * sessions for the branch god-user are NOT affected — only future link opens.
 */
export async function revokePreviewToken(args: {
  db: WildwoodClient["_"]["db"];
  token: string;
}): Promise<{ ok: true }> {
  const identifier = `${PREVIEW_TOKEN_IDENTIFIER_PREFIX}${args.token}`;
  await executeSql(args.db, `delete from "verification" where "identifier" = ?`, [identifier]);
  return { ok: true };
}

// ── internal helpers ────────────────────────────────────────────────────

/** Find-or-create the per-branch anonymous user via better-auth's admin API. */
async function findOrCreatePreviewUser(
  auth: WildwoodAuthInstance,
  db: WildwoodClient["_"]["db"],
  email: string,
  branch: string,
): Promise<{ id: string; email: string }> {
  // Try to find existing user by email.
  const rows = (await executeSql(
    db,
    `select "id" from "user" where "email" = ?`,
    [email],
  )) as { rows?: Array<Record<string, unknown>> };
  const existing = rows?.rows?.[0];
  if (existing && typeof existing.id === "string") {
    return { id: existing.id, email };
  }

  // Create a new anonymous user. We insert directly into the user table because
  // the anonymous plugin's endpoint creates a new session too (which we don't
  // want here — the editor is already signed in). We set isAnonymous = 1 (SQLite
  // boolean) so the authorize gate can deny writes.
  const id = randomToken().slice(0, 16);
  await executeSql(
    db,
    `insert into "user" ("id", "name", "email", "emailVerified", "isAnonymous", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `Preview: ${branch}`,
      email,
      1, // emailVerified = true (SQLite integer)
      1, // isAnonymous = true (SQLite integer)
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  return { id, email };
}

/** Create a session for a user by inserting directly into the session table. */
async function createSessionForUser(
  db: WildwoodClient["_"]["db"],
  userId: string,
  branch: string,
): Promise<{ setCookie: string; token: string }> {
  const token = randomToken();
  const sessionId = randomToken().slice(0, 16);
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_SEC * 1000);
  const now = new Date();

  // Insert the session row directly. better-auth's session cookie is a plain
  // opaque token that gets looked up in the DB — it's NOT signed (the cookie
  // *value* is the session token). So we can set the cookie directly.
  //
  // The cookie name defaults to `${cookiePrefix}.session_token` where
  // cookiePrefix defaults to "better-auth". This matches what
  // `nextCookies()` reads.
  await executeSql(
    db,
    `insert into "session" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?)`,
    [sessionId, token, userId, expiresAt.toISOString(), now.toISOString(), now.toISOString()],
  );

  const cookieName = "better-auth.session_token";
  const setCookie = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEFAULT_SESSION_TTL_SEC}`;

  return { setCookie, token };
}

/** Execute SQL via the libsql client. Works for both the wildwood DB and auth. */
async function executeSql(
  db: { client?: { execute(s: string | { sql: string; args: unknown[] }): Promise<unknown> } } | unknown,
  sql: string,
  args: unknown[],
): Promise<unknown> {
  // The wildwood `db` exposes `drizzle.$client` (libsql). The auth instance's
  // underlying client is the same libsql client passed to createClient. We
  // access it via the `client` property if available, otherwise treat `db` as
  // the client directly.
  const client =
    (db as { client?: LibsqlClientLike })?.client ??
    (db as LibsqlClientLike);
  if (!client || typeof client.execute !== "function") {
    throw new Error("preview-token: could not resolve libsql client for SQL execution");
  }
  return client.execute({ sql, args });
}