import { H3 } from "h3";
import type { Tr33Client } from "@/client/index";
import { GitHubRemote } from "@/git/remote/github";

export function createGitHubRouter(client: Tr33Client): H3 {
  const git = client._.git;
  const org = git.config.org;
  const repo = git.config.repo;
  const repoFull = `${org}/${repo}`;
  const remote = git.remote;
  const router = new H3();

  router.get("/installation", async () => {
    if (!(remote instanceof GitHubRemote)) {
      return Response.json({ status: "not_configured", repo: repoFull, org, repoName: repo });
    }
    const installation = await remote.getRepoInstallationStatus();
    const appSlug = process.env.GITHUB_APP_SLUG?.trim();
    const installUrl = installation.status === "not_installed" && appSlug ? `https://github.com/apps/${appSlug}/installations/new` : undefined;
    return Response.json({
      repo: repoFull, org, repoName: repo,
      ...installation, installUrl,
      hint: installation.status === "not_installed" ? `Install the GitHub App on ${repoFull} to edit with Tr33.` : undefined,
    });
  });

  return router;
}
