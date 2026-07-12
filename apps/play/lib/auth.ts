import { createTr33PlayAuth } from "tr33/nextjs/play-auth";
import { headers } from "next/headers";

import { playgroundDatabaseUrl } from "./playground-database-url";

const playAuth = createTr33PlayAuth({
  appName: "Tr33 Play",
  databaseUrl: playgroundDatabaseUrl,
});

export const auth = playAuth.auth;
export const ensurePlaygroundAuthSchema = playAuth.ensureAuthSchema;
export const getPlaygroundAuthState = playAuth.getAuthState;
export const isPlaygroundSessionAllowed = playAuth.isSessionAllowed;
export const requirePlaygroundApiSession = playAuth.requireApiSession;

export type PlaygroundSession = Awaited<
  ReturnType<typeof auth.api.getSession>
>;

export async function getPlaygroundGithubAuthState(): Promise<{
  email: string | null;
  githubSignedIn: boolean;
}> {
  await ensurePlaygroundAuthSchema();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    return { email: null, githubSignedIn: false };
  }

  try {
    const accounts = await auth.api.listUserAccounts({
      headers: requestHeaders,
    });
    return {
      email: session.user.email,
      githubSignedIn: accounts.some(
        (account) => account.providerId === "github",
      ),
    };
  } catch {
    return { email: session.user.email, githubSignedIn: false };
  }
}
