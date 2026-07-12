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
  | { type: "git.createPr"; ref: string; title?: string; body?: string };

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
   * Credentials used by Wildwood's GitHub remote. `app` uses installation tokens
   * for reads/writes. `default` preserves the old env/gh-token behavior.
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
