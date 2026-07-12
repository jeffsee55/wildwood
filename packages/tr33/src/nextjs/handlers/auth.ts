import { type Tr33AuthAction, userFromUnknownSession } from "@/client/auth";
import type { Tr33Client } from "@/client/index";

export type AuthContext = {
  client: Tr33Client;
  request: Request;
};

export async function resolveAuthUser(client: Tr33Client, request: Request) {
  if (client._.auth?.getUser) return client._.auth.getUser(request);
  if (client._.auth?.betterAuth) {
    const session = await client._.auth.betterAuth.api.getSession({
      headers: request.headers,
    });
    return userFromUnknownSession(session);
  }
  return null;
}

export async function authorizeGitAction(
  client: Tr33Client,
  request: Request,
  action: Tr33AuthAction,
): Promise<Response | null> {
  const authorize = client._.auth?.authorize;
  if (!authorize) return null;
  const user = await resolveAuthUser(client, request);
  const result = await authorize({ action, config: client._.config, request, user });
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
