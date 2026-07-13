import { createClient as createLibsql } from "@libsql/client";

type GitHubRepo = {
  default_branch?: string;
  full_name?: string;
  html_url?: string;
  name?: string;
  owner?: { login?: string };
  private?: boolean;
};

function repoMatches(repo: GitHubRepo, query: string): boolean {
  if (!query) return true;
  const haystack =
    `${repo.full_name ?? ""} ${repo.owner?.login ?? ""} ${repo.name ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function getAccessToken(request: Request): Promise<string | null> {
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<Record<string, unknown>>;
  const { betterAuth } = (await dynamicImport("better-auth")) as {
    betterAuth: (o: unknown) => {
      api: { getAccessToken(a: unknown): Promise<{ accessToken: string | null }> };
    };
  };
  const { LibsqlDialect } = (await dynamicImport("@libsql/kysely-libsql")) as {
    LibsqlDialect: new (o: unknown) => unknown;
  };
  const { nextCookies } = (await dynamicImport("better-auth/next-js")) as {
    nextCookies: () => unknown;
  };

  const libsql = createLibsql({
    url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood.db",
    authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
  });

  const github =
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : undefined;

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

  try {
    const result = await auth.api.getAccessToken({
      headers: request.headers,
      body: { providerId: "github" },
    });
    return result.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const token = await getAccessToken(request);
  if (!token) {
    return Response.json({ error: "Sign in with GitHub to list repositories." }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const owner = url.searchParams.get("owner")?.trim() ?? "";
  const ownerType = url.searchParams.get("ownerType") === "org" ? "org" : "user";
  const endpoint = owner
    ? ownerType === "org"
      ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated&type=all`
      : "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner"
    : "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member";

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    return Response.json(
      { error: `GitHub repos request failed: ${response.status}` },
      { status: response.status },
    );
  }

  const repos = ((await response.json()) as GitHubRepo[])
    .filter((repo) => repoMatches(repo, query))
    .slice(0, 30)
    .map((repo) => ({
      defaultBranch: repo.default_branch ?? "main",
      fullName: repo.full_name ?? `${repo.owner?.login ?? ""}/${repo.name ?? ""}`,
      htmlUrl: repo.html_url ?? null,
      name: repo.name ?? "",
      owner: repo.owner?.login ?? "",
      private: Boolean(repo.private),
    }))
    .filter((repo) => repo.owner && repo.name);

  return Response.json({ repos });
}
