import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt, deviceAuthorization } from "better-auth/plugins";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import type { Client } from "@libsql/client";
/** An explicit canonical origin is required: never derive OAuth issuers from untrusted Host headers. */
export function createIdentity(options: {
  client: Client;
  origin: string;
  base?: string;
  secret: string;
  development?: boolean;
  github?: { clientId: string; clientSecret: string };
}) {
  const base = options.base ?? "/cms";
  const development =
    options.development === true &&
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(options.origin).hostname);
  const auth = betterAuth({
    baseURL: options.origin,
    basePath: `${base}/auth`,
    secret: options.secret,
    database: {
      dialect: new LibsqlDialect({ client: options.client } as unknown as ConstructorParameters<
        typeof LibsqlDialect
      >[0]),
      type: "sqlite",
    },
    socialProviders: options.github ? { github: options.github } : undefined,
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    plugins: [
      ...(development
        ? [
            {
              id: "wildwood-local-login",
              endpoints: {
                localLogin: createAuthEndpoint(
                  "/sign-in/local",
                  {
                    method: "POST",
                    body: z.object({ oauth_query: z.string().optional() }),
                  },
                  async (ctx) => {
                    if (ctx.request?.headers.get("origin") !== options.origin)
                      throw new APIError("FORBIDDEN");
                    const existing =
                      await ctx.context.internalAdapter.findUserByEmail("local@wildwood.invalid");
                    const user =
                      existing?.user ??
                      (await ctx.context.internalAdapter.createUser(
                        {
                          email: "local@wildwood.invalid",
                          emailVerified: true,
                          name: "Local developer",
                        },
                        { method: "local-development" },
                      ));
                    const session = await ctx.context.internalAdapter.createSession(user.id);
                    if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
                    await setSessionCookie(ctx, { session, user });
                    return ctx.json({ url: "/" });
                  },
                ),
              },
            },
          ]
        : []),
      jwt(),
      deviceAuthorization({ verificationUri: `${options.origin}${base}/device` }),
      mcp({
        resource: `${options.origin}${base}/mcp`,
        // This issuer serves one resource; clients still require user consent and audience validation.
        enforcePerClientResources: false,
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "content:read",
          "content:write",
          "drafts:create",
        ],
        loginPage: `${base}/sign-in`,
        consentPage: `${base}/consent`,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  });
  let migration: Promise<void> | undefined;
  async function migrate() {
    // Better Auth calculates migrations from the current schema. On serverless
    // cold starts, two workers can calculate the same plan before either runs it.
    // If one wins a CREATE TABLE race, recalculate until the database is complete.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const plan = await getMigrations(auth.options);
        await plan.runMigrations();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
      }
    }
  }
  return {
    providers: { github: !!options.github, local: development },
    async clientName(id: string) {
      await this.ready();
      const client = await (
        await auth.$context
      ).adapter.findOne<{ name?: string }>({
        model: "oauthClient",
        where: [{ field: "clientId", value: id }],
      });
      return client?.name ?? id;
    },
    async userById(id: string) {
      await this.ready();
      return (await auth.$context).internalAdapter.findUserById(id);
    },
    async ready() {
      await (migration ??= migrate().catch((error) => {
        migration = undefined;
        throw error;
      }));
    },
    async handler(request: Request) {
      await this.ready();
      return auth.handler(request);
    },
    async user(headers: Headers) {
      await this.ready();
      const session = await auth.api.getSession({ headers });
      return session?.user ?? null;
    },
    guard: (handler: Parameters<typeof requireMcpAuth>[1]) =>
      requireMcpAuth(auth, handler, { resource: `${options.origin}${base}/mcp` }),
  };
}
