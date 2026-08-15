import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sqliteDate } from "./column-types";

export const wildwoodAuthSetting = sqliteTable(
  "wildwood_auth_setting",
  {
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: sqliteDate("created_at").notNull(),
    updatedAt: sqliteDate("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key] })],
);

export const wildwoodProject = sqliteTable(
  "wildwood_project",
  {
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    orgName: text("org_name").notNull(),
    repoName: text("repo_name").notNull(),
    configRef: text("config_ref").notNull(),
    createdAt: sqliteDate("created_at").notNull(),
    updatedAt: sqliteDate("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("wildwoodProject_name_uidx").on(table.provider, table.orgName, table.repoName),
    uniqueIndex("wildwoodProject_external_uidx")
      .on(table.provider, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

export const wildwoodAccessGrant = sqliteTable(
  "wildwood_access_grant",
  {
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => wildwoodProject.id),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    permissions: text("permissions").notNull(),
    refSelectors: text("ref_selectors").notNull(),
    constraints: text("constraints"),
    kind: text("kind").notNull().default("custom"),
    issuedBy: text("issued_by").notNull(),
    parentGrantId: text("parent_grant_id").references(
      (): AnySQLiteColumn => wildwoodAccessGrant.id,
    ),
    createdAt: sqliteDate("created_at").notNull(),
    expiresAt: sqliteDate("expires_at"),
    revokedAt: sqliteDate("revoked_at"),
    usesRemaining: integer("uses_remaining"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wildwoodAccessGrant_subject_idx").on(
      table.projectId,
      table.subjectType,
      table.subjectId,
    ),
    index("wildwoodAccessGrant_parent_idx").on(table.parentGrantId),
    uniqueIndex("wildwoodAccessGrant_owner_uidx")
      .on(table.projectId)
      .where(sql`${table.kind} = 'owner'`),
  ],
);

export const wildwoodCredential = sqliteTable(
  "wildwood_credential",
  {
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => wildwoodProject.id),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    grantId: text("grant_id").references(() => wildwoodAccessGrant.id),
    secretHash: text("secret_hash"),
    createdAt: sqliteDate("created_at").notNull(),
    expiresAt: sqliteDate("expires_at"),
    revokedAt: sqliteDate("revoked_at"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wildwoodCredential_subject_idx").on(table.projectId, table.subjectType, table.subjectId),
    uniqueIndex("wildwoodCredential_secretHash_uidx").on(table.secretHash),
  ],
);

export const wildwoodApprovalRequest = sqliteTable(
  "wildwood_approval_request",
  {
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => wildwoodProject.id),
    requestedBy: text("requested_by").notNull(),
    permission: text("permission").notNull(),
    sourceRef: text("source_ref").notNull(),
    targetRef: text("target_ref").notNull(),
    sourceCommit: text("source_commit").notNull(),
    reason: text("reason"),
    status: text("status").notNull(),
    createdAt: sqliteDate("created_at").notNull(),
    expiresAt: sqliteDate("expires_at").notNull(),
    decidedAt: sqliteDate("decided_at"),
    decidedBy: text("decided_by"),
    grantId: text("grant_id").references(() => wildwoodAccessGrant.id),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wildwoodApproval_status_idx").on(table.projectId, table.status),
  ],
);

export const wildwoodAuthEvent = sqliteTable(
  "wildwood_auth_event",
  {
    id: text("id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => wildwoodProject.id),
    type: text("type").notNull(),
    actorId: text("actor_id"),
    subjectId: text("subject_id"),
    grantId: text("grant_id"),
    createdAt: sqliteDate("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wildwoodAuthEvent_created_idx").on(table.projectId, table.createdAt),
  ],
);
