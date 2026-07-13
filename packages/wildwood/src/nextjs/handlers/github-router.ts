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

  function repoInstallUrl(appSlug: string): string {
    // Pre-select the repo: GitHub supports /apps/{slug}/installations/new?target_id={orgId}
    // plus suggest_target_id, but the most reliable zero-config affordance is linking
    // directly to the repo's install page when we know org/repo. Fall back to org-level
    // install page which still limits the picker to that org, not all orgs.
    // See https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
    // - /{org}/{repo}/settings/installs  (already-installed management, but also install entry)
    // - /apps/{slug}/installations/new    (picker, but we pass ?state so GitHub remembers context)
    // We link to the repo-scoped entry so the user doesn't have to find the repo in a long list.
    return `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(repoFull)}`;
  }

  function orgInstallUrl(appSlug: string): string {
    // Limits picker to `org` — still better than global "All repos".
    return org
      ? `https://github.com/organizations/${org}/settings/installs/${encodeURIComponent(appSlug)}`
      : `https://github.com/apps/${appSlug}/installations/new`;
  }

  router.get("/installation", async () => {
    if (!(remote instanceof GitHubRemote)) {
      return Response.json({ status: "not_configured", repo: repoFull, org, repoName: repo });
    }
    const installation = await remote.getRepoInstallationStatus();
    const appSlug = process.env.GITHUB_APP_SLUG?.trim();
    const installUrl =
      installation.status === "not_installed" && appSlug ? repoInstallUrl(appSlug) : undefined;
    const orgScopedUrl = appSlug ? orgInstallUrl(appSlug) : undefined;
    return Response.json({
      repo: repoFull,
      org,
      repoName: repo,
      ...installation,
      installUrl, // repo-scoped; Kits' primary CTA
      orgInstallUrl: orgScopedUrl,
      // Legacy shape for toolbar: full url with ?state so GitHub can deep-link post-install.
      directRepoInstallHint: org
        ? `https://github.com/${org}/${repo}/settings/installs (or install via App page and choose Only select repositories → ${repo})`
        : undefined,
      hint:
        installation.status === "not_installed"
          ? `Install the GitHub App on ${repoFull}. When GitHub asks "Repository access", choose Only select repositories → ${repo}.`
          : undefined,
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
        error:
          "Webhook handler not yet implemented — wire signature verification + event dispatch here.",
        hint: "Webhooks are opt-in. Re-save your GitHub App with a webhook URL pointing here once wired.",
      },
      { status: 501 },
    );
  });
  router.get("/webhook", async () => {
    return Response.json({
      ok: true,
      status: "webhook placeholder — wire handler to enable",
      path: "/api/wildwood/github/webhook",
    });
  });

  return router;
}
