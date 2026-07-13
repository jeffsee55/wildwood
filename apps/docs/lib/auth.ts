// NOTE: deliberately NOT importing from wildwood/nextjs/play-auth.
// That dist file has bare `import { betterAuth } from "better-auth"` which
// Turbopack on Vercel couldn't resolve when traced via `packages/wildwood/dist`.
// Keeping this factory self-contained means `apps/docs` only depends on
// its own `better-auth` + `@libsql/client` (both direct deps) and avoids the
// "unexpected file in NFT list" warning entirely.
//
// Logic mirrors `packages/wildwood/src/nextjs/play-auth.ts` so docs and play
// share the same GitHub-App-as-OAuth happy path: GITHUB_CLIENT_ID/_SECRET are
// the App's own OAuth creds returned by the manifest conversion.

import { createClient as libsqlCreateClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDialect } from "kysely";
import Database from "better-sqlite3";

// Inlined as ultimate fallback so Vercel build never fails on missing FS file.
// Generated from packages/wildwood/src/sqlite/better-auth-schema.sql
const INLINE_BETTER_AUTH_SCHEMA = `create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");`;

function docsDatabaseUrl(): string {
  return (
    process.env.WILDWOOD_DOCS_DATABASE_URL?.trim() ||
    process.env.TURSO_DATABASE_URL?.trim() ||
    process.env.BETTER_AUTH_DATABASE_URL?.trim() ||
    process.env.LIBSQL_URL?.trim() ||
    "file:./wildwood-docs.db"
  );
}

function resolveFilePath(url: string): string {
  if (url.startsWith("file://")) return fileURLToPath(url);
  const raw = url.slice("file:".length);
  if (!raw || raw === ":memory:") return raw || ":memory:";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function makeBetterSqlite3(dbPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (Database as any).default ?? Database;
  return new Ctor(dbPath);
}

async function readSchemaSql(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), "packages/wildwood/src/sqlite/better-auth-schema.sql"),
    path.join(process.cwd(), "../../packages/wildwood/src/sqlite/better-auth-schema.sql"),
  ];
  try {
    const wildwoodPkg = path.dirname(require.resolve("wildwood/package.json"));
    candidates.push(path.join(wildwoodPkg, "src/sqlite/better-auth-schema.sql"));
  } catch {}
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return await readFile(p, "utf8");
    } catch {}
  }
  return INLINE_BETTER_AUTH_SCHEMA;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
}

function githubProvider(): BetterAuthOptions["socialProviders"] | undefined {
  const id = process.env.GITHUB_CLIENT_ID?.trim();
  const secret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!id || !secret) return undefined;
  return { github: { clientId: id, clientSecret: secret } };
}

function trustedOrigins(): string[] | undefined {
  const raw = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function createDocsAuth() {
  let ensurePromise: Promise<void> | null = null;

  function url(): string {
    return process.env.BETTER_AUTH_DATABASE_URL || docsDatabaseUrl();
  }

  function db(): BetterAuthOptions["database"] {
    const u = url();
    if (u.startsWith("file:")) {
      return {
        dialect: new SqliteDialect({ database: makeBetterSqlite3(resolveFilePath(u)) as never }),
        type: "sqlite",
        transaction: false,
      };
    }
    return {
      dialect: new LibsqlDialect({
        url: u,
        authToken: process.env.BETTER_AUTH_DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || "",
      }),
      type: "sqlite",
      transaction: false,
    };
  }

  const auth = betterAuth({
    appName: "Wildwood Docs",
    database: db(),
    emailAndPassword: { enabled: true },
    socialProviders: githubProvider(),
    trustedOrigins: trustedOrigins(),
    plugins: [nextCookies()],
  });

  type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
  type State =
    | { status: "authenticated"; session: NonNullable<Session> }
    | { status: "unauthenticated"; session: null }
    | { status: "forbidden"; session: NonNullable<Session> };

  function ensureAuthSchema(): Promise<void> {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      const u = url();
      const sql = await readSchemaSql();
      if (u.startsWith("file:")) {
        const conn = makeBetterSqlite3(resolveFilePath(u));
        try {
          for (const st of splitSql(sql)) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (conn as any).exec(st);
            } catch (e) {
              if (!(e instanceof Error) || !/already exists/i.test(e.message)) throw e;
            }
          }
        } finally {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (conn as any).close();
        }
        return;
      }
      const client = libsqlCreateClient({
        url: u,
        authToken: process.env.BETTER_AUTH_DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || "",
      });
      try {
        for (const st of splitSql(sql)) {
          try {
            await client.execute(st);
          } catch (e) {
            if (!(e instanceof Error) || !/already exists/i.test(e.message)) throw e;
          }
        }
      } finally {
        client.close();
      }
    })();
    return ensurePromise;
  }

  function allowed(session: NonNullable<Session>): boolean {
    const list = (process.env.DOCS_ALLOWED_EMAILS || process.env.PLAYGROUND_ALLOWED_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (list.length === 0) return process.env.NODE_ENV !== "production";
    return list.includes(session.user.email.toLowerCase());
  }

  async function getAuthState(): Promise<State> {
    await ensureAuthSchema();
    const s = await auth.api.getSession({ headers: await headers() });
    if (!s) return { status: "unauthenticated", session: null };
    if (!allowed(s)) return { status: "forbidden", session: s };
    return { status: "authenticated", session: s };
  }

  async function requireApiSession(req: Request): Promise<Response | null> {
    await ensureAuthSchema();
    const s = await auth.api.getSession({ headers: req.headers });
    if (!s) return new Response("Authentication required", { status: 401 });
    if (!allowed(s)) return new Response("Forbidden", { status: 403 });
    return null;
  }

  return { auth, ensureAuthSchema, getAuthState, isSessionAllowed: allowed, requireApiSession };
}

const docsAuth = createDocsAuth();
export const auth = docsAuth.auth;
export const ensureDocsAuthSchema = docsAuth.ensureAuthSchema;
export const getDocsAuthState = docsAuth.getAuthState;
export const isDocsSessionAllowed = docsAuth.isSessionAllowed;
export const requireDocsApiSession = docsAuth.requireApiSession;
