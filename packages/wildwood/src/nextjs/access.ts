/**
 * Ref-scoped authorization for the managed Wildwood CMS.
 *
 * Better Auth owns identity and credentials. This module owns durable authority:
 * grants are checked online on every request so expiry and revocation take effect
 * immediately. Git refs remain the source of truth for branch existence.
 */

import type { WildwoodAuthAction, WildwoodAuthUser } from "./auth";
import type { InStatement } from "@libsql/client";

export const WILDWOOD_PERMISSIONS = [
  "content.read",
  "content.write",
  "branch.create",
  "branch.delete",
  "branch.share",
  "merge.request",
  "merge.execute",
  "agent.create",
  "approval.decide",
  "access.inspect",
  "access.revoke",
  "access.manage",
] as const;

export type WildwoodPermission = (typeof WILDWOOD_PERMISSIONS)[number];

export type WildwoodRefSelector =
  | { type: "exact"; ref: string }
  | { type: "prefix"; prefix: string };

export type WildwoodGrantConstraints = {
  baseRefs?: WildwoodRefSelector[];
  targetRefs?: WildwoodRefSelector[];
  delegablePermissions?: WildwoodPermission[];
  sourceCommit?: string;
};

export type WildwoodGrant = {
  id: string;
  subjectType: "user" | "agent" | "anonymous";
  subjectId: string;
  permissions: WildwoodPermission[];
  refs: WildwoodRefSelector[];
  constraints?: WildwoodGrantConstraints;
  kind: "owner" | "contributor" | "agent" | "share" | "approval" | "custom";
  issuedBy: string;
  parentGrantId?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  usesRemaining?: number;
};

/** Email address allowed to claim the project's one-time owner bootstrap. */
export type WildwoodBootstrapOwner = string;

export type WildwoodBootstrapConfig = { owner: WildwoodBootstrapOwner };

export type WildwoodAccessDb = {
  execute(statement: InStatement): Promise<unknown>;
};

export type WildwoodProject = {
  id: string;
  provider: string;
  externalId?: string;
  org: string;
  repo: string;
  configRef: string;
};

export type WildwoodProjectInput = Omit<WildwoodProject, "id">;

type RowsResult = { rows?: Array<Record<string, unknown>> };

function rows(result: unknown): Array<Record<string, unknown>> {
  return ((result as RowsResult | undefined)?.rows ?? []) as Array<Record<string, unknown>>;
}

function jsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function jsonObject<T extends object>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function projectFromRow(row: Record<string, unknown>): WildwoodProject {
  return {
    id: String(row.id),
    provider: String(row.provider),
    externalId: optionalString(row.external_id),
    org: String(row.org_name),
    repo: String(row.repo_name),
    configRef: String(row.config_ref),
  };
}

/** Resolve a mutable repository name to its stable Wildwood project id. */
export async function resolveProject(args: {
  db: WildwoodAccessDb;
  project: WildwoodProjectInput;
}): Promise<WildwoodProject> {
  const byExternal = args.project.externalId
    ? await args.db.execute({
        sql: `select * from "wildwood_project"
          where "provider" = ? and "external_id" = ? limit 1`,
        args: [args.project.provider, args.project.externalId],
      })
    : undefined;
  let row = byExternal ? rows(byExternal)[0] : undefined;
  if (!row) {
    const byName = await args.db.execute({
      sql: `select * from "wildwood_project"
        where "provider" = ? and "org_name" = ? and "repo_name" = ? limit 1`,
      args: [args.project.provider, args.project.org, args.project.repo],
    });
    row = rows(byName)[0];
  }

  const now = new Date().toISOString();
  if (!row) {
    const id = crypto.randomUUID();
    await args.db.execute({
      sql: `insert or ignore into "wildwood_project"
        ("id", "provider", "external_id", "org_name", "repo_name", "config_ref", "created_at", "updated_at")
        values (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        args.project.provider,
        args.project.externalId ?? null,
        args.project.org,
        args.project.repo,
        args.project.configRef,
        now,
        now,
      ],
    });
    const created = await args.db.execute({
      sql: `select * from "wildwood_project"
        where ("provider" = ? and "org_name" = ? and "repo_name" = ?)
           or (? is not null and "provider" = ? and "external_id" = ?) limit 1`,
      args: [
        args.project.provider,
        args.project.org,
        args.project.repo,
        args.project.externalId ?? null,
        args.project.provider,
        args.project.externalId ?? null,
      ],
    });
    row = rows(created)[0];
  }
  if (!row) throw new Error("Wildwood could not resolve the project identity");

  const current = projectFromRow(row);
  if (
    current.org !== args.project.org ||
    current.repo !== args.project.repo ||
    current.configRef !== args.project.configRef ||
    (!current.externalId && args.project.externalId)
  ) {
    await args.db.execute({
      sql: `update "wildwood_project"
        set "org_name" = ?, "repo_name" = ?, "config_ref" = ?,
            "external_id" = coalesce("external_id", ?), "updated_at" = ? where "id" = ?`,
      args: [
        args.project.org,
        args.project.repo,
        args.project.configRef,
        args.project.externalId ?? null,
        now,
        current.id,
      ],
    });
  }
  return {
    ...args.project,
    id: current.id,
    externalId: args.project.externalId ?? current.externalId,
  };
}

function grantFromRow(row: Record<string, unknown>): WildwoodGrant {
  return {
    id: String(row.id),
    subjectType: String(row.subject_type) as WildwoodGrant["subjectType"],
    subjectId: String(row.subject_id),
    permissions: jsonArray<WildwoodPermission>(row.permissions),
    refs: jsonArray<WildwoodRefSelector>(row.ref_selectors),
    constraints: jsonObject<WildwoodGrantConstraints>(row.constraints),
    kind: String(row.kind) as WildwoodGrant["kind"],
    issuedBy: String(row.issued_by),
    parentGrantId: optionalString(row.parent_grant_id),
    createdAt: String(row.created_at),
    expiresAt: optionalString(row.expires_at),
    revokedAt: optionalString(row.revoked_at),
    usesRemaining: typeof row.uses_remaining === "number" ? row.uses_remaining : undefined,
  };
}

export async function createGrant(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  grant: Omit<WildwoodGrant, "id" | "createdAt"> & { id?: string; createdAt?: string };
}): Promise<WildwoodGrant> {
  const grant: WildwoodGrant = {
    ...args.grant,
    id: args.grant.id ?? crypto.randomUUID(),
    createdAt: args.grant.createdAt ?? new Date().toISOString(),
  };
  await args.db.execute({
    sql: `insert into "wildwood_access_grant"
      ("id", "project_id", "subject_type", "subject_id", "permissions",
       "ref_selectors", "constraints", "kind", "issued_by", "parent_grant_id",
       "created_at", "expires_at", "revoked_at", "uses_remaining")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      grant.id,
      args.project.id,
      grant.subjectType,
      grant.subjectId,
      JSON.stringify(grant.permissions),
      JSON.stringify(grant.refs),
      grant.constraints ? JSON.stringify(grant.constraints) : null,
      grant.kind,
      grant.issuedBy,
      grant.parentGrantId ?? null,
      grant.createdAt,
      grant.expiresAt ?? null,
      grant.revokedAt ?? null,
      grant.usesRemaining ?? null,
    ],
  });
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "grant_id", "created_at", "metadata")
      values (?, ?, 'grant.created', ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      grant.issuedBy,
      grant.subjectId,
      grant.id,
      grant.createdAt,
      JSON.stringify({ kind: grant.kind, subjectType: grant.subjectType }),
    ],
  });
  return grant;
}

export function refMatches(selector: WildwoodRefSelector, ref: string): boolean {
  if (selector.type === "exact") return selector.ref === ref;
  return ref.startsWith(selector.prefix);
}

export function selectorsMatch(selectors: WildwoodRefSelector[], ref: string): boolean {
  return selectors.some((selector) => refMatches(selector, ref));
}

function ownerMatches(bootstrap: WildwoodBootstrapConfig, user: WildwoodAuthUser): boolean {
  return bootstrap.owner.trim().toLowerCase() === user.email?.trim().toLowerCase();
}

export async function ensureBootstrapOwner(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  bootstrap: WildwoodBootstrapConfig;
  user: WildwoodAuthUser;
}): Promise<void> {
  if (!args.user.id || !ownerMatches(args.bootstrap, args.user)) return;

  const existing = await args.db.execute({
    sql: `select "id" from "wildwood_access_grant"
      where "project_id" = ? and "kind" = 'owner' limit 1`,
    args: [args.project.id],
  });
  if (rows(existing).length > 0) return;

  const now = new Date().toISOString();
  const grantId = crypto.randomUUID();
  const inserted = await args.db.execute({
    sql: `insert or ignore into "wildwood_access_grant"
      ("id", "project_id", "subject_type", "subject_id", "permissions",
       "ref_selectors", "kind", "issued_by", "created_at")
      values (?, ?, 'user', ?, ?, ?, 'owner', ?, ?)`,
    args: [
      grantId,
      args.project.id,
      args.user.id,
      JSON.stringify(WILDWOOD_PERMISSIONS),
      JSON.stringify([{ type: "prefix", prefix: "" } satisfies WildwoodRefSelector]),
      args.user.id,
      now,
    ],
  });
  if (((inserted as { rowsAffected?: number }).rowsAffected ?? 1) === 0) return;
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "grant_id", "created_at", "metadata")
      values (?, ?, 'owner.bootstrapped', ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      args.user.id,
      args.user.id,
      grantId,
      now,
      JSON.stringify({ email: args.user.email }),
    ],
  });
}

export async function createContributorAccess(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  userId: string;
  issuedBy: string;
}): Promise<{ base: WildwoodGrant; creator: WildwoodGrant }> {
  const existing = await args.db.execute({
    sql: `select * from "wildwood_access_grant"
      where "project_id" = ? and "subject_type" = 'user'
        and "subject_id" = ? and "kind" = 'contributor' and "revoked_at" is null
        and ("expires_at" is null or "expires_at" > ?)`,
    args: [args.project.id, args.userId, new Date().toISOString()],
  });
  const current = rows(existing).map(grantFromRow);
  let base = current.find(
    (grant) =>
      grant.permissions.length === 1 &&
      grant.permissions[0] === "content.read" &&
      grant.refs.some(
        (selector) => selector.type === "exact" && selector.ref === args.project.configRef,
      ),
  );
  let creator = current.find(
    (grant) =>
      grant.permissions.length === 1 &&
      grant.permissions[0] === "branch.create" &&
      grant.refs.some((selector) => selector.type === "prefix" && selector.prefix === ""),
  );

  base ??= await createGrant({
    db: args.db,
    project: args.project,
    grant: {
      subjectType: "user",
      subjectId: args.userId,
      permissions: ["content.read"],
      refs: [{ type: "exact", ref: args.project.configRef }],
      kind: "contributor",
      issuedBy: args.issuedBy,
    },
  });
  creator ??= await createGrant({
    db: args.db,
    project: args.project,
    grant: {
      subjectType: "user",
      subjectId: args.userId,
      permissions: ["branch.create"],
      refs: [{ type: "prefix", prefix: "" }],
      constraints: {
        baseRefs: [{ type: "exact", ref: args.project.configRef }],
      },
      kind: "contributor",
      issuedBy: args.issuedBy,
    },
  });
  return { base, creator };
}

const CONTRIBUTOR_BRANCH_PERMISSIONS: WildwoodPermission[] = [
  "content.read",
  "content.write",
  "branch.delete",
  "branch.share",
  "merge.request",
  "agent.create",
  "access.revoke",
];

/**
 * Record ownership of one server-generated branch as an exact-ref child grant.
 * Branch names stay friendly and opaque while revocation remains per-branch.
 */
export async function createContributorBranchAccess(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  userId: string;
  ref: string;
  issuedBy?: string;
}): Promise<WildwoodGrant> {
  const active = await listActiveGrants({
    db: args.db,
    project: args.project,
    subjectType: "user",
    subjectId: args.userId,
  });
  const existing = active.find(
    (grant) =>
      CONTRIBUTOR_BRANCH_PERMISSIONS.every((permission) =>
        grant.permissions.includes(permission),
      ) && grant.refs.some((selector) => selector.type === "exact" && selector.ref === args.ref),
  );
  if (existing) return existing;

  const parent = active.find(
    (grant) =>
      grant.permissions.includes("branch.create") &&
      selectorsMatch(grant.refs, args.ref) &&
      (!grant.constraints?.baseRefs ||
        selectorsMatch(grant.constraints.baseRefs, args.project.configRef)),
  );
  if (!parent) {
    throw new Error(`No active grant can create branch "${args.ref}"`);
  }

  return createGrant({
    db: args.db,
    project: args.project,
    grant: {
      subjectType: "user",
      subjectId: args.userId,
      permissions: CONTRIBUTOR_BRANCH_PERMISSIONS,
      refs: [{ type: "exact", ref: args.ref }],
      constraints: {
        targetRefs: [{ type: "exact", ref: args.project.configRef }],
        delegablePermissions: ["content.read", "content.write", "merge.request"],
      },
      kind: "contributor",
      issuedBy: args.issuedBy ?? args.userId,
      parentGrantId: parent.id,
    },
  });
}

export async function listProjectGrants(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  includeRevoked?: boolean;
}): Promise<WildwoodGrant[]> {
  const result = await args.db.execute({
    sql: `select * from "wildwood_access_grant"
      where "project_id" = ?
      ${args.includeRevoked ? "" : 'and "revoked_at" is null'}
      order by "created_at" desc`,
    args: [args.project.id],
  });
  return rows(result).map(grantFromRow);
}

export async function listActiveGrants(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  subjectType: WildwoodGrant["subjectType"];
  subjectId: string;
  now?: Date;
}): Promise<WildwoodGrant[]> {
  const now = (args.now ?? new Date()).toISOString();
  const result = await args.db.execute({
    sql: `select * from "wildwood_access_grant"
      where "project_id" = ?
        and "subject_type" = ? and "subject_id" = ?
        and "revoked_at" is null
        and ("expires_at" is null or "expires_at" > ?)
        and ("uses_remaining" is null or "uses_remaining" > 0)`,
    args: [args.project.id, args.subjectType, args.subjectId, now],
  });
  const grants = rows(result).map(grantFromRow);
  if (grants.length === 0) return [];

  // Walk the full delegation chain so revoking a user grant also invalidates
  // agent -> approval grandchildren, not only direct children.
  const ancestors = new Map<string, WildwoodGrant>();
  let pending = [
    ...new Set(grants.map((grant) => grant.parentGrantId).filter(Boolean)),
  ] as string[];
  while (pending.length > 0) {
    const unresolved = pending.filter((id) => !ancestors.has(id));
    if (unresolved.length === 0) break;
    const placeholders = unresolved.map(() => "?").join(", ");
    const parentResult = await args.db.execute({
      sql: `select * from "wildwood_access_grant"
        where "project_id" = ? and "id" in (${placeholders})`,
      args: [args.project.id, ...unresolved],
    });
    const found = rows(parentResult).map(grantFromRow);
    for (const parent of found) ancestors.set(parent.id, parent);
    const foundIds = new Set(found.map((parent) => parent.id));
    // A missing parent remains absent from the map and therefore invalid.
    pending = found
      .map((parent) => parent.parentGrantId)
      .filter((id): id is string => typeof id === "string" && !ancestors.has(id));
    if (foundIds.size === 0) break;
  }

  const active = (grant: WildwoodGrant, visiting = new Set<string>()): boolean => {
    if (grant.revokedAt) return false;
    if (grant.expiresAt && grant.expiresAt <= now) return false;
    if (grant.usesRemaining !== undefined && grant.usesRemaining <= 0) return false;
    if (!grant.parentGrantId) return true;
    if (visiting.has(grant.id)) return false;
    const parent = ancestors.get(grant.parentGrantId);
    if (!parent) return false;
    const next = new Set(visiting);
    next.add(grant.id);
    return active(parent, next);
  };
  return grants.filter((grant) => active(grant));
}

type Requirement = {
  permission: WildwoodPermission;
  ref: string;
  baseRef?: string;
  targetRef?: string;
  sourceCommit?: string;
};

export function requirementsForAction(
  action: WildwoodAuthAction,
  configRef: string,
): Requirement[] {
  switch (action.type) {
    case "content.read":
      return [{ permission: "content.read", ref: action.ref }];
    case "content.update":
    case "content.delete":
      return [{ permission: "content.write", ref: action.ref }];
    case "git.switchRef":
      return [{ permission: "content.read", ref: action.ref }];
    case "git.createBranch":
      return [
        {
          permission: "branch.create",
          ref: action.name,
          baseRef: action.baseRef ?? configRef,
        },
        { permission: "content.read", ref: action.baseRef ?? configRef },
      ];
    case "git.add":
    case "git.patchWorktree":
    case "git.commit":
    case "git.discard":
    case "git.push":
    case "git.pull":
      return [{ permission: "content.write", ref: action.ref }];
    case "git.merge":
      return [
        {
          permission: "merge.execute",
          ref: action.ref,
          targetRef: configRef,
          sourceCommit: action.sourceCommit,
        },
      ];
    case "git.createPr":
      return [{ permission: "merge.request", ref: action.ref, targetRef: configRef }];
    case "branch.share":
      return [{ permission: "branch.share", ref: action.ref }];
  }
}

function grantSatisfies(grant: WildwoodGrant, requirement: Requirement): boolean {
  if (!grant.permissions.includes(requirement.permission)) return false;
  if (!selectorsMatch(grant.refs, requirement.ref)) return false;
  if (requirement.baseRef && grant.constraints?.baseRefs) {
    if (!selectorsMatch(grant.constraints.baseRefs, requirement.baseRef)) return false;
  }
  if (requirement.targetRef && grant.constraints?.targetRefs) {
    if (!selectorsMatch(grant.constraints.targetRefs, requirement.targetRef)) return false;
  }
  if (
    grant.constraints?.sourceCommit &&
    grant.constraints.sourceCommit !== requirement.sourceCommit
  ) {
    return false;
  }
  return true;
}

function subjectTypeForUser(user: WildwoodAuthUser): WildwoodGrant["subjectType"] {
  return user.managedSubjectType ?? (user.isAnonymous ? "anonymous" : "user");
}

export async function authorizeManagedAction(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  user: WildwoodAuthUser | null;
  action: WildwoodAuthAction;
}): Promise<{ allowed: true; grants: WildwoodGrant[] } | { allowed: false; reason: string }> {
  if (!args.user?.id) return { allowed: false, reason: "Authentication required" };
  const grants = await listActiveGrants({
    db: args.db,
    project: args.project,
    subjectType: subjectTypeForUser(args.user),
    subjectId: args.user.id,
  });
  if (grants.length === 0) return { allowed: false, reason: "No active access grant" };

  for (const requirement of requirementsForAction(args.action, args.project.configRef)) {
    const satisfying = grants.find((grant) => grantSatisfies(grant, requirement));
    if (!satisfying) {
      return {
        allowed: false,
        reason: `Missing ${requirement.permission} for ref "${requirement.ref}"`,
      };
    }
    if (
      requirement.permission === "merge.execute" &&
      satisfying.kind === "approval" &&
      satisfying.usesRemaining !== undefined
    ) {
      const consumed = await args.db.execute({
        sql: `update "wildwood_access_grant"
          set "uses_remaining" = "uses_remaining" - 1
          where "id" = ? and "uses_remaining" > 0 and "revoked_at" is null`,
        args: [satisfying.id],
      });
      if (((consumed as { rowsAffected?: number }).rowsAffected ?? 0) === 0) {
        return { allowed: false, reason: "The merge approval was already used" };
      }
      await args.db.execute({
        sql: `insert into "wildwood_auth_event"
          ("id", "project_id", "type", "actor_id", "subject_id", "grant_id", "created_at", "metadata")
          values (?, ?, 'approval.consumed', ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          args.project.id,
          args.user.id,
          satisfying.subjectId,
          satisfying.id,
          new Date().toISOString(),
          JSON.stringify({ ref: requirement.ref, sourceCommit: requirement.sourceCommit }),
        ],
      });
    }
  }
  return { allowed: true, grants };
}

export async function authorizeManagedPermission(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  user: WildwoodAuthUser | null;
  permission: WildwoodPermission;
  ref?: string;
}): Promise<{ allowed: true; grants: WildwoodGrant[] } | { allowed: false; reason: string }> {
  if (!args.user?.id) return { allowed: false, reason: "Authentication required" };
  const grants = await listActiveGrants({
    db: args.db,
    project: args.project,
    subjectType: subjectTypeForUser(args.user),
    subjectId: args.user.id,
  });
  const ref = args.ref ?? "";
  if (!grants.some((grant) => grantSatisfies(grant, { permission: args.permission, ref }))) {
    return { allowed: false, reason: `Missing ${args.permission}` };
  }
  return { allowed: true, grants };
}

const DEFAULT_AGENT_PERMISSIONS: WildwoodPermission[] = [
  "content.read",
  "content.write",
  "merge.request",
];

/**
 * Delegate one user's exact-ref branch authority to an MCP agent principal.
 * The agent grant stays a child of the user's branch grant, so revoking either
 * the branch or the user's authority immediately invalidates the delegation.
 */
export async function createAgentBranchGrant(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  userId: string;
  agentId: string;
  ref: string;
  permissions?: WildwoodPermission[];
  expiresAt: string;
}): Promise<WildwoodGrant> {
  const requested = [...new Set(args.permissions ?? DEFAULT_AGENT_PERMISSIONS)];
  if (requested.length === 0) throw new Error("At least one agent permission is required");

  const userGrants = await listActiveGrants({
    db: args.db,
    project: args.project,
    subjectType: "user",
    subjectId: args.userId,
  });
  const parent = userGrants.find((grant) => {
    const delegable =
      grant.kind === "owner" ? grant.permissions : (grant.constraints?.delegablePermissions ?? []);
    return (
      grant.permissions.includes("agent.create") &&
      selectorsMatch(grant.refs, args.ref) &&
      requested.every(
        (permission) => grant.permissions.includes(permission) && delegable.includes(permission),
      )
    );
  });
  if (!parent) {
    throw new Error(`No grant can delegate the requested agent permissions for ref "${args.ref}"`);
  }

  const parentExpiry = parent.expiresAt ? Date.parse(parent.expiresAt) : Number.POSITIVE_INFINITY;
  const expiresAt = new Date(Math.min(Date.parse(args.expiresAt), parentExpiry)).toISOString();
  return createGrant({
    db: args.db,
    project: args.project,
    grant: {
      subjectType: "agent",
      subjectId: args.agentId,
      permissions: requested,
      refs: [{ type: "exact", ref: args.ref }],
      constraints: { targetRefs: parent.constraints?.targetRefs },
      kind: "agent",
      issuedBy: args.userId,
      parentGrantId: parent.id,
      expiresAt,
    },
  });
}

function randomSecret(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function secretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export type WildwoodAgentSession = {
  agentId: string;
  token: string;
  grant: WildwoodGrant;
  expiresAt: string;
};

/** Issue one opaque, short-lived credential whose authority is an exact-ref child grant. */
export async function createAgentSession(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  user: WildwoodAuthUser;
  ref: string;
  permissions?: WildwoodPermission[];
  ttlSeconds?: number;
}): Promise<WildwoodAgentSession> {
  if (!args.user.id || subjectTypeForUser(args.user) !== "user") {
    throw new Error("A signed-in user is required to create an agent session");
  }
  const requested = [...new Set(args.permissions ?? DEFAULT_AGENT_PERMISSIONS)];
  if (requested.length === 0) throw new Error("At least one agent permission is required");

  const userGrants = await listActiveGrants({
    db: args.db,
    project: args.project,
    subjectType: "user",
    subjectId: args.user.id,
  });
  const parent = userGrants.find((grant) => {
    const delegable =
      grant.kind === "owner" ? grant.permissions : (grant.constraints?.delegablePermissions ?? []);
    return (
      grant.permissions.includes("agent.create") &&
      selectorsMatch(grant.refs, args.ref) &&
      requested.every(
        (permission) => grant.permissions.includes(permission) && delegable.includes(permission),
      )
    );
  });
  if (!parent) {
    throw new Error(`No grant can delegate the requested agent permissions for ref "${args.ref}"`);
  }

  const ttlSeconds = Math.min(Math.max(Math.floor(args.ttlSeconds ?? 60 * 60), 60), 24 * 60 * 60);
  const requestedExpiry = Date.now() + ttlSeconds * 1000;
  const parentExpiry = parent.expiresAt ? Date.parse(parent.expiresAt) : Number.POSITIVE_INFINITY;
  const expiresAt = new Date(Math.min(requestedExpiry, parentExpiry)).toISOString();
  const agentId = `agent_${crypto.randomUUID()}`;
  const grant = await createGrant({
    db: args.db,
    project: args.project,
    grant: {
      subjectType: "agent",
      subjectId: agentId,
      permissions: requested,
      refs: [{ type: "exact", ref: args.ref }],
      constraints: { targetRefs: parent.constraints?.targetRefs },
      kind: "agent",
      issuedBy: args.user.id,
      parentGrantId: parent.id,
      expiresAt,
    },
  });
  const token = `wwa_${randomSecret()}`;
  const now = new Date().toISOString();
  await args.db.execute({
    sql: `insert into "wildwood_credential"
      ("id", "project_id", "kind", "subject_type", "subject_id", "grant_id",
       "secret_hash", "created_at", "expires_at") values (?, ?, 'agent_token', 'agent', ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      agentId,
      grant.id,
      await secretHash(token),
      now,
      expiresAt,
    ],
  });
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "grant_id", "created_at", "metadata")
      values (?, ?, 'agent.session.created', ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      args.user.id,
      agentId,
      grant.id,
      now,
      JSON.stringify({ ref: args.ref, permissions: requested, expiresAt }),
    ],
  });
  return { agentId, token, grant, expiresAt };
}

/** Resolve an agent bearer token online; grant/parent revocation takes effect immediately. */
export async function verifyAgentSession(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  token: string;
}): Promise<{ agentId: string; grant: WildwoodGrant } | null> {
  if (!args.token.startsWith("wwa_")) return null;
  const now = new Date().toISOString();
  const result = await args.db.execute({
    sql: `select "subject_id", "grant_id" from "wildwood_credential"
      where "project_id" = ? and "kind" = 'agent_token'
        and "secret_hash" = ? and "revoked_at" is null
        and ("expires_at" is null or "expires_at" > ?) limit 1`,
    args: [args.project.id, await secretHash(args.token), now],
  });
  const credential = rows(result)[0];
  if (!credential) return null;
  const agentId = String(credential.subject_id);
  const grantId = String(credential.grant_id);
  const grants = await listActiveGrants({
    db: args.db,
    project: args.project,
    subjectType: "agent",
    subjectId: agentId,
  });
  const grant = grants.find((candidate) => candidate.id === grantId);
  return grant ? { agentId, grant } : null;
}

export type WildwoodApprovalRequest = {
  id: string;
  requestedBy: string;
  permission: "merge.execute";
  sourceRef: string;
  targetRef: string;
  sourceCommit: string;
  reason?: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  grantId?: string;
};

function approvalFromRow(row: Record<string, unknown>): WildwoodApprovalRequest {
  return {
    id: String(row.id),
    requestedBy: String(row.requested_by),
    permission: "merge.execute",
    sourceRef: String(row.source_ref),
    targetRef: String(row.target_ref),
    sourceCommit: String(row.source_commit),
    reason: optionalString(row.reason),
    status: String(row.status) as WildwoodApprovalRequest["status"],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: optionalString(row.decided_at),
    decidedBy: optionalString(row.decided_by),
    grantId: optionalString(row.grant_id),
  };
}

export async function createMergeApprovalRequest(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  requestedBy: string;
  sourceRef: string;
  sourceCommit: string;
  reason?: string;
  ttlSeconds?: number;
}): Promise<WildwoodApprovalRequest> {
  const now = new Date();
  const existing = await args.db.execute({
    sql: `select * from "wildwood_approval_request"
      where "project_id" = ? and "requested_by" = ?
        and "permission" = 'merge.execute' and "source_ref" = ? and "target_ref" = ?
        and "source_commit" = ? and "status" = 'pending' and "expires_at" > ? limit 1`,
    args: [
      args.project.id,
      args.requestedBy,
      args.sourceRef,
      args.project.configRef,
      args.sourceCommit,
      now.toISOString(),
    ],
  });
  if (rows(existing)[0]) return approvalFromRow(rows(existing)[0]!);

  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + Math.min(Math.max(args.ttlSeconds ?? 15 * 60, 60), 60 * 60) * 1000,
  ).toISOString();
  const approval: WildwoodApprovalRequest = {
    id: crypto.randomUUID(),
    requestedBy: args.requestedBy,
    permission: "merge.execute",
    sourceRef: args.sourceRef,
    targetRef: args.project.configRef,
    sourceCommit: args.sourceCommit,
    reason: args.reason,
    status: "pending",
    createdAt,
    expiresAt,
  };
  await args.db.execute({
    sql: `insert into "wildwood_approval_request"
      ("id", "project_id", "requested_by", "permission", "source_ref",
       "target_ref", "source_commit", "reason", "status", "created_at", "expires_at")
      values (?, ?, ?, 'merge.execute', ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [
      approval.id,
      args.project.id,
      approval.requestedBy,
      approval.sourceRef,
      approval.targetRef,
      approval.sourceCommit,
      approval.reason ?? null,
      approval.createdAt,
      approval.expiresAt,
    ],
  });
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "created_at", "metadata")
      values (?, ?, 'approval.requested', ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      args.requestedBy,
      args.requestedBy,
      createdAt,
      JSON.stringify({
        approvalId: approval.id,
        sourceRef: approval.sourceRef,
        sourceCommit: approval.sourceCommit,
      }),
    ],
  });
  return approval;
}

export async function listApprovalRequests(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  status?: WildwoodApprovalRequest["status"];
}): Promise<WildwoodApprovalRequest[]> {
  const result = await args.db.execute({
    sql: `select * from "wildwood_approval_request"
      where "project_id" = ? ${args.status ? 'and "status" = ?' : ""}
      order by "created_at" desc`,
    args: args.status ? [args.project.id, args.status] : [args.project.id],
  });
  return rows(result).map(approvalFromRow);
}

export async function decideApprovalRequest(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  approvalId: string;
  actorId: string;
  decision: "approve" | "deny";
}): Promise<WildwoodApprovalRequest> {
  const result = await args.db.execute({
    sql: `select * from "wildwood_approval_request"
      where "id" = ? and "project_id" = ? limit 1`,
    args: [args.approvalId, args.project.id],
  });
  const row = rows(result)[0];
  if (!row) throw new Error("Approval request not found");
  const approval = approvalFromRow(row);
  if (approval.status !== "pending") throw new Error(`Approval is already ${approval.status}`);
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    await args.db.execute({
      sql: `update "wildwood_approval_request" set "status" = 'expired' where "id" = ?`,
      args: [approval.id],
    });
    throw new Error("Approval request expired");
  }

  const decidedAt = new Date().toISOString();
  let grant: WildwoodGrant | undefined;
  if (args.decision === "approve") {
    const agentGrants = await listActiveGrants({
      db: args.db,
      project: args.project,
      subjectType: "agent",
      subjectId: approval.requestedBy,
    });
    const parent = agentGrants.find((candidate) =>
      selectorsMatch(candidate.refs, approval.sourceRef),
    );
    if (!parent) throw new Error("The requesting agent session is no longer active");
    grant = await createGrant({
      db: args.db,
      project: args.project,
      grant: {
        subjectType: "agent",
        subjectId: approval.requestedBy,
        permissions: ["merge.execute"],
        refs: [{ type: "exact", ref: approval.sourceRef }],
        constraints: {
          targetRefs: [{ type: "exact", ref: approval.targetRef }],
          sourceCommit: approval.sourceCommit,
        },
        kind: "approval",
        issuedBy: args.actorId,
        parentGrantId: parent.id,
        expiresAt: approval.expiresAt,
        usesRemaining: 1,
      },
    });
  }
  const status = args.decision === "approve" ? "approved" : "denied";
  await args.db.execute({
    sql: `update "wildwood_approval_request"
      set "status" = ?, "decided_at" = ?, "decided_by" = ?, "grant_id" = ? where "id" = ?`,
    args: [status, decidedAt, args.actorId, grant?.id ?? null, approval.id],
  });
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "grant_id", "created_at", "metadata")
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      `approval.${status}`,
      args.actorId,
      approval.requestedBy,
      grant?.id ?? null,
      decidedAt,
      JSON.stringify({ approvalId: approval.id }),
    ],
  });
  return { ...approval, status, decidedAt, decidedBy: args.actorId, grantId: grant?.id };
}

export async function revokeGrant(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  grantId: string;
  actorId: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await args.db.execute({
    sql: `update "wildwood_access_grant" set "revoked_at" = ?
      where "id" = ? and "project_id" = ? and "revoked_at" is null`,
    args: [now, args.grantId, args.project.id],
  });
  if (((updated as { rowsAffected?: number }).rowsAffected ?? 0) === 0) return false;
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "grant_id", "created_at")
      values (?, ?, 'grant.revoked', ?, ?, ?)`,
    args: [crypto.randomUUID(), args.project.id, args.actorId, args.grantId, now],
  });
  return true;
}
