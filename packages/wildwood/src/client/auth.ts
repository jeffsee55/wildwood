/**
 * Client / provider layer — git transport only.
 * No `authenticate` / `authorize` here. Those live solely in
 * `createWildwoodRoute({ auth: { authenticate, authorize } })`.
 *
 * All fields optional and resilient to `undefined`. We trim / normalize
 * internally so callers can pass `process.env.X` directly without `.trim()`.
 */

function trimOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function trimStringOrNumber(v: unknown): string | number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : undefined;
  }
  return undefined;
}

export type WildwoodGitHubAppAuth = {
  /** `process.env.GITHUB_APP_ID` — trimmed internally. */
  appId?: string | number | undefined;
  /** `process.env.GITHUB_PRIVATE_KEY` — `\n` normalized internally. */
  privateKey?: string | undefined;
  /** `process.env.GITHUB_APP_INSTALLATION_ID` — trimmed internally. */
  installationId?: string | number | undefined;
};

/**
 * Single resilient shape — not a discriminated union that forces casts.
 * All fields optional, tolerates `string | undefined` from env.
 * Supports both `{ type:"app", app:{...} }` and shorthand `{ appId, privateKey }`.
 *
 * This is the ONE GitHub credential object. The read/write git transport uses
 * `appId`/`privateKey`/`installationId` (or `token`). The CMS layer's GitHub
 * sign-in (`createCMS({ auth: { github: true } })`) reuses `clientId`/
 * `clientSecret` from the SAME object — declare your GitHub App once.
 */
export type WildwoodGitHubAuth = {
  type?: "app" | "token" | "default" | undefined;
  app?: WildwoodGitHubAppAuth | undefined;
  token?: string | undefined;
  // shorthand fields — also optional for env passthrough
  appId?: string | number | undefined;
  privateKey?: string | undefined;
  installationId?: string | number | undefined;
  // OAuth sign-in creds — used by the CMS layer's better-auth GitHub provider.
  // Transport (git read/write) ignores these; sign-in ignores app/private key.
  clientId?: string | undefined;
  clientSecret?: string | undefined;
};

export type WildwoodProviderConfig = {
  github?: WildwoodGitHubAuth | undefined;
};

export function normalizeProviderConfig(
  input: WildwoodProviderConfig | undefined,
): WildwoodProviderConfig | undefined {
  if (!input) return undefined;
  const gh = input.github;
  if (!gh) return { github: undefined };

  // OAuth sign-in creds live on the same object and are transport-agnostic —
  // preserve them across every branch so the CMS layer can reuse them.
  const clientId = trimOrUndefined(gh.clientId);
  const clientSecret = trimOrUndefined(gh.clientSecret);
  const oauth = {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  };
  const hasOauth = clientId !== undefined || clientSecret !== undefined;

  const type =
    typeof gh.type === "string" ? (gh.type.trim() as "app" | "token" | "default") : undefined;

  if (type === "token") {
    const token = trimOrUndefined(gh.token);
    if (!token) return hasOauth ? { github: { ...oauth } } : { github: undefined };
    return { github: { type: "token", token, ...oauth } };
  }

  if (type === "default") {
    return { github: { type: "default", ...oauth } };
  }

  // app-shaped: { app: { appId, privateKey, installationId } }
  if (gh.app && typeof gh.app === "object") {
    const appId = trimStringOrNumber(gh.app.appId);
    const privateKey = trimOrUndefined(gh.app.privateKey);
    const installationId = trimStringOrNumber(gh.app.installationId);
    if (!appId && !privateKey && !installationId && type !== "app") {
      return hasOauth ? { github: { ...oauth } } : { github: undefined };
    }
    return {
      github: {
        type: "app",
        app: {
          ...(appId !== undefined ? { appId } : {}),
          ...(privateKey !== undefined ? { privateKey } : {}),
          ...(installationId !== undefined ? { installationId } : {}),
        },
        ...oauth,
      },
    };
  }

  // shorthand: { appId, privateKey, installationId } at top level
  const hasShorthand = gh.appId != null || gh.privateKey != null || gh.installationId != null;
  if (hasShorthand) {
    const appId = trimStringOrNumber(gh.appId);
    const privateKey = trimOrUndefined(gh.privateKey);
    const installationId = trimStringOrNumber(gh.installationId);
    if (!appId && !privateKey && !installationId) {
      return hasOauth ? { github: { ...oauth } } : { github: undefined };
    }
    return {
      github: {
        type: "app",
        app: {
          ...(appId !== undefined ? { appId } : {}),
          ...(privateKey !== undefined ? { privateKey } : {}),
          ...(installationId !== undefined ? { installationId } : {}),
        },
        ...oauth,
      },
    };
  }

  // Only OAuth creds were provided (sign-in without git App transport).
  if (hasOauth) return { github: { ...oauth } };

  // Fallback: if caller passed raw env values directly (e.g. token string trimmed elsewhere)
  // but we already handled token above, so nothing to do.
  return { github: undefined };
}
