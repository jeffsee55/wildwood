/**
 * Client / provider layer — git transport only.
 * No `authenticate` / `authorize` here. Those live solely in
 * `createWildwoodRoute({ auth: { authenticate, authorize } })`.
 *
 * Everything optional / lenient — we don't want TS errors to block dev.
 * Missing creds → dev falls back to `gh` CLI / `GITHUB_TOKEN`, prod
 * throws only at request time if DB not pre-indexed.
 */

export type WildwoodGitHubAppAuth = {
  /** Optional — env may be unset in dev; validated only at request time when actually needed. */
  appId?: string | number | undefined | null;
  privateKey?: string | undefined | null;
  installationId?: string | number | undefined | null;
};

export type WildwoodGitHubAuth =
  | { type?: "app" | undefined | null; app?: WildwoodGitHubAppAuth | undefined | null; token?: string | undefined | null }
  | { type?: "token" | undefined | null; token?: string | undefined | null; app?: WildwoodGitHubAppAuth | undefined | null }
  | { type?: "default" | undefined | null; app?: WildwoodGitHubAppAuth | undefined | null; token?: string | undefined | null }
  | { appId?: string | number | undefined | null; privateKey?: string | undefined | null; installationId?: string | number | undefined | null };

export type WildwoodProviderConfig = {
  /** `undefined` = not configured → dev fallback (gh CLI), prod requires pre-indexed DB. */
  github?: WildwoodGitHubAuth | undefined | null;
};
