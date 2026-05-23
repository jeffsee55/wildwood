import { getDocsTr33 } from "./tr33";

let ready: Promise<void> | null = null;

/** Initialize schema and index the configured ref from local disk or GitHub. */
export function ensureDocsContentReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const tr33 = getDocsTr33();
      await tr33._.db.init();
      await tr33._.git.switch({ ref: tr33._.config.ref });
    })();
  }
  return ready;
}
