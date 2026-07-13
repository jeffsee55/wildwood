// Server-only auth boundary — reads GitHub sign-in state via better-auth.
// Reuses the DB from wildwood client via getOrCreateAuth so we don't duplicate TURSO_* config.
// Keeps dynamic import indirection so Turbopack doesn't trace better-auth from dist.

import { PlaygroundControls } from "@/components/playground-controls";
import type { PlaygroundConfig } from "@/lib/playground-config";
import { playDebug } from "@/lib/playground-log";
import { PlaygroundToolbarSection, jsonFallback } from "./playground-main";
import { Suspense } from "react";
import { headers } from "next/headers";
import { createClient as createLibsql } from "@libsql/client";

async function getGithubAuthState(): Promise<{ email: string | null; githubSignedIn: boolean }> {
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<Record<string, unknown>>;
  const { betterAuth } = (await dynamicImport("better-auth")) as {
    betterAuth: (o: unknown) => {
      api: {
        getSession(a: { headers: Headers }): Promise<{ user: { email: string } } | null>;
        listUserAccounts(a: { headers: Headers }): Promise<Array<{ providerId: string }>>;
      };
    };
  };
  const { LibsqlDialect } = (await dynamicImport("@libsql/kysely-libsql")) as {
    LibsqlDialect: new (o: unknown) => unknown;
  };
  const { nextCookies } = (await dynamicImport("better-auth/next-js")) as {
    nextCookies: () => unknown;
  };

  const github =
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : undefined;

  // Single DB — same Turso DB as wildwood client. In future route owns this.
  const libsql = createLibsql({
    url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood.db",
    authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
  });

  const auth = betterAuth({
    appName: "Wildwood Play",
    secret: process.env.BETTER_AUTH_SECRET,
    database: {
      dialect: new (LibsqlDialect as unknown as new (o: unknown) => unknown)({ client: libsql }),
      type: "sqlite",
    },
    emailAndPassword: { enabled: true },
    socialProviders: github,
    plugins: [nextCookies()],
  });

  const h = await headers();
  const session = await auth.api.getSession({ headers: h as unknown as Headers });
  if (!session) return { email: null, githubSignedIn: false };
  try {
    const accounts = await auth.api.listUserAccounts({ headers: h as unknown as Headers });
    return {
      email: session.user.email,
      githubSignedIn: accounts.some((a) => a.providerId === "github"),
    };
  } catch {
    return { email: session.user.email, githubSignedIn: false };
  }
}

export async function PlaygroundAuthShell({ initialConfig }: { initialConfig: PlaygroundConfig }) {
  const githubAuth = await getGithubAuthState();
  const config =
    githubAuth.githubSignedIn || initialConfig.source === "local"
      ? initialConfig
      : { ...initialConfig, source: "local" as const };

  playDebug("page.configLoaded", {
    activeRef: config.ref,
    config,
    githubSignedIn: githubAuth.githubSignedIn,
  });

  return (
    <>
      <PlaygroundControls githubSignedIn={githubAuth.githubSignedIn} initial={config} />
      <Suspense fallback={jsonFallback}>
        <PlaygroundToolbarSection config={config} userEmail={githubAuth.email} />
      </Suspense>
    </>
  );
}
