import { createClient as libsqlCreateClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import BetterSqlite3 from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDialect } from "kysely";

type Tr33PlayAuthOptions = {
  databaseUrl: () => string;
  appName?: string;
  allowedEmailsEnv?: string;
};

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

function readBetterAuthSchemaSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../sqlite/better-auth-schema.sql"),
    path.resolve(process.cwd(), "packages/tr33/src/sqlite/better-auth-schema.sql"),
    path.resolve(
      process.cwd(),
      "../../packages/tr33/src/sqlite/better-auth-schema.sql",
    ),
  ];
  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) {
    throw new Error(
      `Could not find Better Auth schema SQL. Checked: ${candidates.join(", ")}`,
    );
  }
  return fs.readFileSync(schemaPath, "utf8");
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
          database: new BetterSqlite3(resolveFileDatabasePath(url)),
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
      const sql = readBetterAuthSchemaSql();

      if (url.startsWith("file:")) {
        const db = new BetterSqlite3(resolveFileDatabasePath(url));
        try {
          for (const statement of splitSqlStatements(sql)) {
            try {
              db.exec(statement);
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
          db.close();
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
