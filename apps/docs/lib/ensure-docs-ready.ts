import {
  getDocsTr33,
  githubInstallHint,
  useLocalContentRoot,
} from "./tr33";

let ready: Promise<void> | null = null;

function isGithubInstallationNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    if ((error as { status: number }).status === 404) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /installation/i.test(message) && /not found/i.test(message);
}

/** Initialize schema and index the configured ref from local disk or GitHub. */
export function ensureDocsContentReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const tr33 = getDocsTr33();
      await tr33._.db.init();
      const ref = tr33._.config.ref;
      try {
        await tr33._.git.switch({ ref });
      } catch (error) {
        if (useLocalContentRoot()) {
          throw error;
        }
        if (!isGithubInstallationNotFound(error)) {
          throw error;
        }
        const worktree = await tr33._.db.refs.get({ ref });
        if (worktree?.rootTree || worktree?.commit) {
          return;
        }
        throw new Error(
          `Cannot load docs from GitHub (${tr33._.config.org}/${tr33._.config.repo}). ${githubInstallHint()}`,
          { cause: error },
        );
      }
    })();
  }
  return ready;
}
