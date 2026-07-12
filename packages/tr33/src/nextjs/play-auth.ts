import { createClient as libsqlCreateClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { SqliteDialect } from "kysely";
import Database from "better-sqlite3";

type Tr33PlayAuthOptions = {
  databaseUrl: () => string;
  appName?: string;
  allowedEmailsEnv?: string;
};

// keep native dep behind a lazy require so `tr33/dist/index.mjs` (docs, etc)
// never has to bundle better-sqlite3. Only play-auth users hit this path.
function createBetterSqlite3(dbPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (Database as any).default ?? Database;
  return new Ctor(dbPath);
}

function resolveFileDatabasePath(databaseUrl: string): string {
  if (databaseUrl.startsWith("file://")) {
    return fileURLToPath(databaseUrl);
  }

  const raw = databaseUrl.slice("file:".length);
  if (raw === "" || raw === ":memory:") {
    return raw || ":memory:";
  }

  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function tr33PackageRoot(): string {
  // After `tsdown`, this file lives at `dist/nextjs/play-auth.mjs`
  // so twoups gets us back to the package root.
  try {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
  } catch {
    try {
      const r = createRequire(import.meta.url);
      return path.dirname(r.resolve("tr33/package.json"));
    } catch {
      return path.join(process.cwd(), "packages/tr33");
    }
  }
}

async function readBetterAuthSchemaSql(): Promise<string> {
  const pkgRoot = tr33PackageRoot();
  const fromDist = path.join(pkgRoot, "src/sqlite/better-auth-schema.sql");
  const fromPkg = path.join(pkgRoot, "sqlite/better-auth-schema.sql");
  const cwdCandidates = [
    path.join(process.cwd(), "packages/tr33/src/sqlite/better-auth-schema.sql"),
    path.join(process.cwd(), "../../packages/tr33/src/sqlite/better-auth-schema.sql"),
  ];
  for (const p of [fromDist, fromPkg, ...cwdCandidates]) {
    try {
      if (fs.existsSync(p)) return await readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Could not find Better Auth schema SQL. Checked: ${[fromDist, fromPkg, ...cwdCandidates].join(", ")}`,
  );
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement && !statement.startsWith("--"));
}

function optionalGithubProvider(): BetterAuthOptions["socialProviders"] {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return {
    github: {
      clientId,
      clientSecret,
    },
  };
}

function trustedOrigins(): string[] | undefined {
  const raw = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (!raw) {
    return undefined;
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createTr33PlayAuth(options: Tr33PlayAuthOptions) {
  let ensureAuthSchemaPromise: Promise<void> | null = null;

  function authDatabaseUrl(): string {
    return process.env.BETTER_AUTH_DATABASE_URL || options.databaseUrl();
  }

  function createAuthDatabase(): BetterAuthOptions["database"] {
    const url = authDatabaseUrl();

    if (url.startsWith("file:")) {
      return {
        dialect: new SqliteDialect({
          database: createBetterSqlite3(resolveFileDatabasePath(url)) as never,
        }),
        type: "sqlite",
        transaction: false,
      };
    }

    return {
      dialect: new LibsqlDialect({
        url,
        authToken:
          process.env.BETTER_AUTH_DATABASE_AUTH_TOKEN ||
          process.env.TURSO_AUTH_TOKEN ||
          "",
      }),
      type: "sqlite",
      transaction: false,
    };
  }

  const auth = betterAuth({
    appName: options.appName || "Tr33 Play",
    database: createAuthDatabase(),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: optionalGithubProvider(),
    trustedOrigins: trustedOrigins(),
    plugins: [nextCookies()],
  });

  type PlaySession = Awaited<ReturnType<typeof auth.api.getSession>>;
  type PlayAuthState =
    | { status: "authenticated"; session: NonNullable<PlaySession> }
    | { status: "unauthenticated"; session: null }
    | { status: "forbidden"; session: NonNullable<PlaySession> };

  function ensureAuthSchema(): Promise<void> {
    if (ensureAuthSchemaPromise) {
      return ensureAuthSchemaPromise;
    }

    ensureAuthSchemaPromise = (async () => {
      const url = authDatabaseUrl();
      const sql = await readBetterAuthSchemaSql();

      if (url.startsWith("file:")) {
        const db = createBetterSqlite3(resolveFileDatabasePath(url));
        try {
          for (const statement of splitSqlStatements(sql)) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (db as any).exec(statement);
            } catch (err) {
              if (
                !(err instanceof Error) ||
                !/already exists/i.test(err.message)
              ) {
                throw err;
              }
            }
          }
        } finally {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (db as any).close();
        }
        return;
      }

      const client = libsqlCreateClient({
        url,
        authToken:
          process.env.BETTER_AUTH_DATABASE_AUTH_TOKEN ||
          process.env.TURSO_AUTH_TOKEN ||
          "",
      });
      try {
        for (const statement of splitSqlStatements(sql)) {
          try {
            await client.execute(statement);
          } catch (err) {
            if (
              !(err instanceof Error) ||
              !/already exists/i.test(err.message)
            ) {
              throw err;
            }
          }
        }
      } finally {
        client.close();
      }
    })();

    return ensureAuthSchemaPromise;
  }

  function isSessionAllowed(session: NonNullable<PlaySession>): boolean {
    const allowedEmails = (
      process.env[options.allowedEmailsEnv || "PLAYGROUND_ALLOWED_EMAILS"] || ""
    )
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (allowedEmails.length === 0) {
      return process.env.NODE_ENV !== "production";
    }

    return allowedEmails.includes(session.user.email.toLowerCase());
  }

  async function getAuthState(): Promise<PlayAuthState> {
    await ensureAuthSchema();
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session) {
      return { status: "unauthenticated", session: null };
    }

    if (!isSessionAllowed(session)) {
      return { status: "forbidden", session };
    }

    return { status: "authenticated", session };
  }

  async function requireApiSession(request: Request): Promise<Response | null> {
    await ensureAuthSchema();
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return new Response("Authentication required", { status: 401 });
    }

    if (!isSessionAllowed(session)) {
      return new Response("You are not allowed to use this playground", {
        status: 403,
      });
    }

    return null;
  }

  return {
    auth,
    ensureAuthSchema,
    getAuthState,
    isSessionAllowed,
    requireApiSession,
  };
}
