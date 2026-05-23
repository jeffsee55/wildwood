import { auth, ensurePlaygroundAuthSchema } from "@/lib/auth";

type GitHubRepo = {
  default_branch?: string;
  full_name?: string;
  html_url?: string;
  name?: string;
  owner?: {
    login?: string;
  };
  private?: boolean;
};

function repoMatches(repo: GitHubRepo, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = `${repo.full_name ?? ""} ${repo.owner?.login ?? ""} ${
    repo.name ?? ""
  }`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function getGitHubAccessToken(request: Request): Promise<string | null> {
  try {
    const result = await auth.api.getAccessToken({
      headers: request.headers,
      body: {
        providerId: "github",
      },
    });
    return result.accessToken;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  await ensurePlaygroundAuthSchema();

  const token = await getGitHubAccessToken(request);
  if (!token) {
    return Response.json(
      { error: "Sign in with GitHub to list repositories." },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const owner = url.searchParams.get("owner")?.trim() ?? "";
  const ownerType = url.searchParams.get("ownerType") === "org" ? "org" : "user";
  const endpoint = owner
    ? ownerType === "org"
      ? `https://api.github.com/orgs/${encodeURIComponent(
          owner,
        )}/repos?per_page=100&sort=updated&type=all`
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
