import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sqliteDate } from "./column-types";

export const user = sqliteTable(
  "user",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("emailVerified").notNull(),
    image: text("image"),
    isAnonymous: integer("isAnonymous").default(0),
    createdAt: sqliteDate("createdAt").notNull(),
    updatedAt: sqliteDate("updatedAt").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").notNull(),
    expiresAt: sqliteDate("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: sqliteDate("createdAt").notNull(),
    updatedAt: sqliteDate("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.id] }), index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").notNull(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: sqliteDate("accessTokenExpiresAt"),
    refreshTokenExpiresAt: sqliteDate("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: sqliteDate("createdAt").notNull(),
    updatedAt: sqliteDate("updatedAt").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] }), index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: sqliteDate("expiresAt").notNull(),
    createdAt: sqliteDate("createdAt").notNull(),
    updatedAt: sqliteDate("updatedAt").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("verification_identifier_idx").on(table.identifier),
  ],
);

export const deviceCode = sqliteTable(
  "deviceCode",
  {
    id: text("id").notNull(),
    deviceCode: text("deviceCode").notNull(),
    userCode: text("userCode").notNull(),
    userId: text("userId"),
    expiresAt: sqliteDate("expiresAt").notNull(),
    status: text("status").notNull(),
    lastPolledAt: sqliteDate("lastPolledAt"),
    pollingInterval: integer("pollingInterval"),
    clientId: text("clientId"),
    scope: text("scope"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("deviceCode_deviceCode_idx").on(table.deviceCode),
    index("deviceCode_userCode_idx").on(table.userCode),
  ],
);

export const jwks = sqliteTable(
  "jwks",
  {
    id: text("id").notNull(),
    publicKey: text("publicKey").notNull(),
    privateKey: text("privateKey").notNull(),
    createdAt: sqliteDate("createdAt").notNull(),
    expiresAt: sqliteDate("expiresAt"),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const oauthClient = sqliteTable(
  "oauthClient",
  {
    id: text("id").notNull(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    disabled: integer("disabled").default(0),
    skipConsent: integer("skipConsent"),
    enableEndSession: integer("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: text("scopes"),
    userId: text("userId").references(() => user.id),
    createdAt: sqliteDate("createdAt"),
    updatedAt: sqliteDate("updatedAt"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: text("redirectUris").notNull(),
    postLogoutRedirectUris: text("postLogoutRedirectUris"),
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: integer("backchannelLogoutSessionRequired"),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: text("grantTypes"),
    responseTypes: text("responseTypes"),
    public: integer("public"),
    type: text("type"),
    requirePKCE: integer("requirePKCE"),
    dpopBoundAccessTokens: integer("dpopBoundAccessTokens").default(0),
    referenceId: text("referenceId"),
    metadata: text("metadata"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("oauthClient_userId_idx").on(table.userId),
  ],
);

export const oauthResource = sqliteTable(
  "oauthResource",
  {
    id: text("id").notNull(),
    identifier: text("identifier").notNull().unique(),
    name: text("name").notNull(),
    accessTokenTtl: integer("accessTokenTtl"),
    refreshTokenTtl: integer("refreshTokenTtl"),
    signingAlgorithm: text("signingAlgorithm"),
    signingKeyId: text("signingKeyId"),
    allowedScopes: text("allowedScopes"),
    customClaims: text("customClaims"),
    dpopBoundAccessTokensRequired: integer("dpopBoundAccessTokensRequired").default(0),
    disabled: integer("disabled").default(0),
    createdAt: sqliteDate("createdAt"),
    updatedAt: sqliteDate("updatedAt"),
    policyVersion: integer("policyVersion").default(1),
    metadata: text("metadata"),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const oauthClientResource = sqliteTable(
  "oauthClientResource",
  {
    id: text("id").notNull(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResource.identifier),
    metadata: text("metadata"),
    createdAt: sqliteDate("createdAt"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("oauthClientResource_clientId_idx").on(table.clientId),
    index("oauthClientResource_resourceId_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauthRefreshToken",
  {
    id: text("id").notNull(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requestedUserInfoClaims"),
    expiresAt: sqliteDate("expiresAt"),
    createdAt: sqliteDate("createdAt"),
    revoked: sqliteDate("revoked"),
    rotatedAt: sqliteDate("rotatedAt"),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: sqliteDate("rotationReplayExpiresAt"),
    authTime: sqliteDate("authTime"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(table.authorizationCodeId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauthAccessToken",
  {
    id: text("id").notNull(),
    token: text("token").unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId").references(() => user.id),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requestedUserInfoClaims"),
    refreshId: text("refreshId").references(() => oauthRefreshToken.id),
    expiresAt: sqliteDate("expiresAt"),
    createdAt: sqliteDate("createdAt"),
    revoked: sqliteDate("revoked"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("oauthAccessToken_authorizationCodeId_idx").on(table.authorizationCodeId),
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauthConsent",
  {
    id: text("id").notNull(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    userId: text("userId").references(() => user.id),
    referenceId: text("referenceId"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requestedUserInfoClaims"),
    scopes: text("scopes").notNull(),
    createdAt: sqliteDate("createdAt"),
    updatedAt: sqliteDate("updatedAt"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = sqliteTable(
  "oauthClientAssertion",
  {
    id: text("id").notNull(),
    expiresAt: sqliteDate("expiresAt").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);
