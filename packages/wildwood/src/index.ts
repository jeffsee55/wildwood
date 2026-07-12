import { z as zod } from "zod/v4";
import {
  collection,
  connect,
  filter,
  json,
  markdown,
  variant,
} from "@/zod/extensions";

export { defineConfig } from "@/client/config";
export { createClient, type WildwoodClient } from "@/client/index";
export type {
  WildwoodAuthAction,
  WildwoodAuthConfig,
  WildwoodAuthUser,
  WildwoodAuthorizeContext,
  WildwoodBetterAuthLike,
  WildwoodGitHubAppAuth,
  WildwoodGitHubAuth,
} from "@/client/auth";

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
