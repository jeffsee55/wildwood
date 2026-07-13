import { z as zod } from "zod/v4";
import {
  collection,
  connect,
  filter,
  json,
  markdown,
  variant,
} from "@/zod/extensions";

export {
  defineConfig,
  type AnyCollection,
  type AnyCollections,
  type Config,
  type ConfigInput,
  type ConfigObject,
  type DefineConfigInput,
} from "@/client/config";
export { createClient, type WildwoodClient } from "@/client/index";
// Provider / git transport types (transport-only, no authz)
export type {
  WildwoodGitHubAppAuth,
  WildwoodGitHubAuth,
  WildwoodProviderConfig,
} from "@/client/auth";
// Route-owned authz types — provider is transport-only; these live on `createWildwoodRoute({ auth })`
export type {
  WildwoodAuthAction,
  WildwoodAuthenticateContext,
  WildwoodAuthenticateFn,
  WildwoodAuthUser,
  WildwoodAuthorizeContext,
  WildwoodAuthorizeFn,
  WildwoodBaseURL,
  WildwoodRouteAuthOptions,
  WildwoodTrustedOrigins,
} from "@/nextjs/auth";
export {
  getVercelSystemEnv,
  isVercel,
  parseGitRemoteUrl,
  resolveIdentity,
  resolveOrg,
  resolveOrigin,
  resolveRef,
  resolveRepo,
  resolveVersion,
  vercelEnv,
  type ResolvedWildwoodIdentity,
  type VercelSystemEnv,
  __resetGitRemoteCache,
  __resetVercelEnvCache,
} from "@/env";

export const z = {
  ...zod,
  variant,
  markdown,
  json,
  connect,
  collection,
  filter,
};

// Core re-exports that UI layers may need without pulling kit/ui.
export { GIT_EMPTY_TREE_OID } from "wildwood-shared";
