import { H3 } from "h3";
import type { WildwoodClient } from "@/client/index";
import { GitHubRemote } from "@/git/remote/github";
import { createGitHubAppManifestRouter } from "./github-app-manifest-router";

export function createGitHubRouter(client: WildwoodClient): H3 {
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
      repo: repoFull,
      org,
      repoName: repo,
      ...installation,
      installUrl,
      hint: installation.status === "not_installed" ? `Install the GitHub App on ${repoFull} to edit with Wildwood.` : undefined,
    });
  });

  // ── first-class manifest flow (always mounted, even when not_configured) ──
  // /api/wildwood/github/app-manifest, /.../start, /.../callback, /.../conversions, /.../dev/write-env
  router.mount("/app-manifest", createGitHubAppManifestRouter(client));

  // Webhook is opt-in — no longer included in default manifest so creation from
  // protected preview deployments doesn't need a permanent bypass secret. When you
  // later add a webhook, point it at /api/wildwood/github/webhook and wire verification.
  router.post("/webhook", async () => {
    return Response.json(
      {
        ok: false,
        error: "Webhook handler not yet implemented — wire signature verification + event dispatch here.",
        hint: "Webhooks are opt-in. Re-save your GitHub App with a webhook URL pointing here once wired.",
      },
      { status: 501 },
    );
  });
  router.get("/webhook", async () => {
    return Response.json({ ok: true, status: "webhook placeholder — wire handler to enable", path: "/api/wildwood/github/webhook" });
  });

  return router;
}
