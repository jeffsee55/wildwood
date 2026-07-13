/**
 * GitHub accounts — uses same DB as wildwood route (Turso) via { client } dialect.
 * Session is owned by createWildwoodRoute, we just need access token.
 */
import { createClient as createLibsql } from "@libsql/client";

async function getAuth() {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<Record<string, unknown>>;
  const { betterAuth } = (await dynamicImport("better-auth")) as {
    betterAuth: (o: unknown) => { api: { getAccessToken(a: unknown): Promise<{ accessToken: string | null }> } };
  };
  const { LibsqlDialect } = (await dynamicImport("@libsql/kysely-libsql")) as {
    LibsqlDialect: new (o: unknown) => unknown;
  };
  const { nextCookies } = (await dynamicImport("better-auth/next-js")) as { nextCookies: () => unknown };

  const libsql = createLibsql({
    url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood.db",
    authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
  });

  const github =
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET } }
      : undefined;

  return betterAuth({
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
}

type GitHubUser = { avatar_url?: string; login?: string };
type GitHubOrg = { avatar_url?: string; login?: string };

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function GET(request: Request) {
  const auth = await getAuth();
  let token: string | null = null;
  try {
    const result = await auth.api.getAccessToken({
      headers: request.headers,
      body: { providerId: "github" },
    });
    token = result.accessToken ?? null;
  } catch {
    token = null;
  }

  if (!token) {
    return Response.json({ error: "Sign in with GitHub to list accounts." }, { status: 401 });
  }

  const [userResponse, orgsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers: githubHeaders(token) }),
    fetch("https://api.github.com/user/orgs?per_page=100", { headers: githubHeaders(token) }),
  ]);

  if (!userResponse.ok || !orgsResponse.ok) {
    return Response.json(
      { error: "GitHub account request failed." },
      { status: userResponse.ok ? orgsResponse.status : userResponse.status },
    );
  }

  const user = (await userResponse.json()) as GitHubUser;
  const orgs = (await orgsResponse.json()) as GitHubOrg[];
  const accounts = [
    user.login ? { avatarUrl: user.avatar_url ?? null, login: user.login, type: "user" as const } : null,
    ...orgs.filter((o) => o.login).map((o) => ({ avatarUrl: o.avatar_url ?? null, login: o.login as string, type: "org" as const })),
  ].filter(Boolean);

  return Response.json({ accounts });
}
