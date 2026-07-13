import type { Config } from "@/client/config";

export type WildwoodAuthUser = {
  id?: string;
  email?: string;
  name?: string;
  image?: string | null;
};

export type WildwoodGitHubAppAuth = {
  appId: string | number;
  privateKey: string;
  /**
   * Optional optimization. If omitted, Wildwood resolves the installation for the
   * configured owner/repo before creating an installation token.
   */
  installationId?: string | number;
};

export type WildwoodGitHubAuth =
  | {
      type: "app";
      app: WildwoodGitHubAppAuth;
    }
  | {
      type: "token";
      token: string;
    }
  | {
      type: "default";
    };

export type WildwoodAuthAction =
  | { type: "git.switchRef"; ref: string }
  | { type: "git.createBranch"; name: string; baseRef?: string }
  | { type: "git.add"; ref: string; paths: string[] }
  | { type: "git.patchWorktree"; ref: string; paths: string[] }
  | { type: "git.commit"; ref: string; message: string }
  | { type: "git.discard"; ref: string }
  | { type: "git.push"; ref: string }
  | { type: "git.pull"; ref: string }
  | { type: "git.merge"; ref: string; message?: string }
  | { type: "git.createPr"; ref: string; title?: string; body?: string }
  | { type: "content.update"; path: string }
  | { type: "content.delete"; path: string };

export type WildwoodAuthorizeContext = {
  action: WildwoodAuthAction;
  config: Config;
  request: Request;
  user: WildwoodAuthUser | null;
};

export type WildwoodBetterAuthLike = {
  api: {
    getSession(args: { headers: Headers }): Promise<unknown>;
  };
};

export type WildwoodAuthConfig = {
  /**
   * Git provider credentials used by Wildwood's remote.
   * `app` = GitHub App (installation tokens), `token` = PAT, `default` = env/gh CLI.
   * This is where GITHUB_APP_ID/PRIVATE_KEY live — the route's `auth.github`
   * boolean can reuse these same creds for OAuth sign-in (no duplicate config).
   */
  github?: WildwoodGitHubAuth;
  /**
   * Optional Better Auth passthrough. Used by the Next handler to identify the
   * current user before calling `authorize`.
   */
  betterAuth?: WildwoodBetterAuthLike;
  /**
   * Custom request user resolver. Takes precedence over `betterAuth`.
   */
  getUser?: (request: Request) => Promise<WildwoodAuthUser | null>;
  /**
   * Return `false` to deny, a `Response` to customize denial, or void/true to allow.
   */
  authorize?: (
    context: WildwoodAuthorizeContext,
  ) => boolean | void | Response | Promise<boolean | void | Response>;
};

/**
 * New `provider` shape for `createClient` — preferred over `auth`.
 * `auth` remains as deprecated alias for one minor.
 *
 * Eventually: `{ github?: GitHubAuth, gitlab?: GitLabAuth, ... }`.
 * Git operations use `provider.github`; sign-in reuses same when
 * `route: { auth: { github: true } }`.
 */
export type WildwoodProviderConfig = {
  github?: WildwoodGitHubAuth;
  // future: gitlab?: ..., google?: ...
  authorize?: WildwoodAuthConfig["authorize"];
  betterAuth?: WildwoodAuthConfig["betterAuth"];
  getUser?: WildwoodAuthConfig["getUser"];
};

export type WildwoodClientAuthInput = WildwoodAuthConfig | WildwoodProviderConfig;

export function userFromUnknownSession(session: unknown): WildwoodAuthUser | null {
  if (!session || typeof session !== "object") {
    return null;
  }
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") {
    return null;
  }
  const u = user as Record<string, unknown>;
  return {
    id: typeof u.id === "string" ? u.id : undefined,
    email: typeof u.email === "string" ? u.email : undefined,
    name: typeof u.name === "string" ? u.name : undefined,
    image: typeof u.image === "string" ? u.image : null,
  };
}
