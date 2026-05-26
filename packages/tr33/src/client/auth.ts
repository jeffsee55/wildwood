import type { Config, ConfigInput } from "@/client/config";

export type Tr33AuthUser = {
  id?: string;
  email?: string;
  name?: string;
  image?: string | null;
};

export type Tr33GitHubAppAuth = {
  appId: string | number;
  privateKey: string;
  /**
   * Optional optimization. If omitted, Tr33 resolves the installation for the
   * configured owner/repo before creating an installation token.
   */
  installationId?: string | number;
};

export type Tr33GitHubAuth =
  | {
      type: "app";
      app: Tr33GitHubAppAuth;
    }
  | {
      type: "token";
      token: string;
    }
  | {
      type: "default";
    };

export type Tr33AuthAction =
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

export type Tr33AuthorizeContext = {
  action: Tr33AuthAction;
  config: Config<ConfigInput>;
  request: Request;
  user: Tr33AuthUser | null;
};

export type Tr33BetterAuthLike = {
  api: {
    getSession(args: { headers: Headers }): Promise<unknown>;
  };
};

export type Tr33AuthConfig = {
  /**
   * Credentials used by Tr33's GitHub remote. `app` uses installation tokens
   * for reads/writes. `default` preserves the old env/gh-token behavior.
   */
  github?: Tr33GitHubAuth;
  /**
   * Optional Better Auth passthrough. Used by the Next handler to identify the
   * current user before calling `authorize`.
   */
  betterAuth?: Tr33BetterAuthLike;
  /**
   * Custom request user resolver. Takes precedence over `betterAuth`.
   */
  getUser?: (request: Request) => Promise<Tr33AuthUser | null>;
  /**
   * Return `false` to deny, a `Response` to customize denial, or void/true to allow.
   */
  authorize?: (
    context: Tr33AuthorizeContext,
  ) => boolean | void | Response | Promise<boolean | void | Response>;
};

export function userFromUnknownSession(session: unknown): Tr33AuthUser | null {
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
