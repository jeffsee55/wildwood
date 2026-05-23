import {
  docsIndexVersion,
  getDocsTr33,
  githubInstallHint,
  isDocsDeployedRuntime,
  isDocsPrefetchBuild,
  resolveDocsIndexRef,
  useLocalContentRoot,
} from "./tr33";

let ready: Promise<void> | null = null;

function missingIndexMessage(ref: string): string {
  const turso = process.env.TR33_DOCS_DATABASE_URL ? "Turso" : "local DB";
  return (
    `Docs index missing in ${turso} for ref "${ref}" (version ${docsIndexVersion()}). ` +
    "Production builds must set TR33_DOCS_DATABASE_URL and run `next build` so content is " +
    "indexed from the repo checkout. " +
    (wantsGithubForEdits()
      ? `For live edits, ${githubInstallHint()}`
      : "")
  );
}

function wantsGithubForEdits(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID?.trim(),
  );
}

async function assertIndexedForProduction(
  tr33: ReturnType<typeof getDocsTr33>,
): Promise<void> {
  const ref = resolveDocsIndexRef();
  const worktree = await tr33._.db.refs.get({ ref });
  const version = docsIndexVersion();

  if (!worktree?.rootTree && !worktree?.commit) {
    throw new Error(missingIndexMessage(ref));
  }
  if (!worktree.versions?.includes(version)) {
    // Indexes written before switch stamped versions are fixed (see git.switch).
    if (worktree.rootTree || worktree.commit) {
      const prev = worktree.versions ?? [];
      await tr33._.db.refs.updateVersions({
        ref,
        versions: prev.includes(version) ? prev : [...prev, version],
      });
      return;
    }
    throw new Error(
      `Docs index in database is missing version "${version}" for ref "${ref}". ` +
        "Re-run production build with the same TR33_DOCS_* env as runtime.",
    );
  }
}

/**
 * Build: init schema + index from local git into LibSQL/Turso.
 * Deployed production: DB only — no git.
 * Dev: index from local git (or GitHub when configured).
 */
export function ensureDocsContentReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const tr33 = getDocsTr33();
      await tr33._.db.init();

      if (isDocsDeployedRuntime()) {
        await assertIndexedForProduction(tr33);
        return;
      }

      if (isDocsPrefetchBuild() && !useLocalContentRoot()) {
        throw new Error(
          "Docs build prefetch requires local content/ in the repository checkout. " +
            "Set TR33_DOCS_SOURCE=local or ensure content/docs exists.",
        );
      }

      await tr33._.git.switch({ ref: tr33._.config.ref });
    })();
  }
  return ready;
}
