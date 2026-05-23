import { auth, ensurePlaygroundAuthSchema } from "@/lib/auth";

type GitHubUser = {
  avatar_url?: string;
  login?: string;
};

type GitHubOrg = {
  avatar_url?: string;
  login?: string;
};

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

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function GET(request: Request) {
  await ensurePlaygroundAuthSchema();

  const token = await getGitHubAccessToken(request);
  if (!token) {
    return Response.json(
      { error: "Sign in with GitHub to list accounts." },
      { status: 401 },
    );
  }

  const [userResponse, orgsResponse] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers: githubHeaders(token),
    }),
    fetch("https://api.github.com/user/orgs?per_page=100", {
      headers: githubHeaders(token),
    }),
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
    user.login
      ? {
          avatarUrl: user.avatar_url ?? null,
          login: user.login,
          type: "user" as const,
        }
      : null,
    ...orgs
      .filter((org) => org.login)
      .map((org) => ({
        avatarUrl: org.avatar_url ?? null,
        login: org.login as string,
        type: "org" as const,
      })),
  ].filter(Boolean);

  return Response.json({ accounts });
}
