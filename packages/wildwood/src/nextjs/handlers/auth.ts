/**
 * Git authz helpers — route-owned only.
 *
 * Provider (client) is transport-only, no authz. So handlers don't read
 * `client._.auth` / `client._.provider` for authz. Route.ts resolves the
 * session user and injects `authOpts` + `user` into this helper.
 */

import type { WildwoodAuthAction, WildwoodAuthUser, WildwoodRouteAuthOptions } from "@/nextjs/auth";

export type AuthGate = {
  auth?: WildwoodRouteAuthOptions;
  request: Request;
  action: WildwoodAuthAction;
  user: WildwoodAuthUser | null;
  /**
   * Optional authenticate evaluation — synthesized from route's `authenticate`
   * so already-signed-in sessions are gated even if they were created before
   * `authenticate` was configured.
   */
  evaluateAuthenticate?: (
    user: WildwoodAuthUser | null,
    request: Request,
  ) => Promise<Response | false | null>;
};

export async function authorizeGitAction(gate: AuthGate): Promise<Response | null> {
  const { auth: authOpts, action, user, request } = gate;
  if (!authOpts) return null;

  if (gate.evaluateAuthenticate) {
    const probe = await gate.evaluateAuthenticate(user, request);
    if (probe) {
      if (probe instanceof Response) return probe;
      if (!user) return new Response("Authentication required", { status: 401 });
      return new Response("Forbidden", { status: 403 });
    }
  }

  if (!authOpts.authorize) return null;

  const result = await authOpts.authorize({ user, action, request });
  if (result instanceof Response) return result;
  if (result === false) return new Response("Forbidden", { status: 403 });
  return null;
}

export function isNativeRemoteNotImplementedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("not implemented for nativeremote")
  );
}
