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
export { createClient, type Tr33Client } from "@/client/index";
export type {
  Tr33AuthAction,
  Tr33AuthConfig,
  Tr33AuthUser,
  Tr33AuthorizeContext,
  Tr33BetterAuthLike,
  Tr33GitHubAppAuth,
  Tr33GitHubAuth,
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
