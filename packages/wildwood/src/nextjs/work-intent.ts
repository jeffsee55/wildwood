/** Persisted, user-claimable edit sessions for MCP agents. */

import type { WildwoodAccessDb, WildwoodProject } from "./access";

export type WildwoodWorkIntentStatus = "pending" | "approved" | "denied" | "expired";

export type WildwoodWorkIntent = {
  id: string;
  requestedBy: string;
  requestedFor: string;
  summary: string;
  status: WildwoodWorkIntentStatus;
  ref?: string;
  grantId?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
};

type RowsResult = { rows?: Array<Record<string, unknown>> };

function rows(result: unknown): Array<Record<string, unknown>> {
  return ((result as RowsResult | undefined)?.rows ?? []) as Array<Record<string, unknown>>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function intentFromRow(row: Record<string, unknown>): WildwoodWorkIntent {
  const status = String(row.status) as WildwoodWorkIntentStatus;
  return {
    id: String(row.id),
    requestedBy: String(row.requested_by),
    requestedFor: String(row.requested_for),
    summary: String(row.summary),
    status:
      status === "pending" && Date.parse(String(row.expires_at)) <= Date.now() ? "expired" : status,
    ref: optionalString(row.ref),
    grantId: optionalString(row.grant_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: optionalString(row.decided_at),
    decidedBy: optionalString(row.decided_by),
  };
}

export async function createWorkIntent(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  requestedBy: string;
  requestedFor: string;
  summary: string;
  ttlSeconds?: number;
}): Promise<WildwoodWorkIntent> {
  const summary = args.summary.trim();
  if (!summary) throw new Error("An edit summary is required");
  if (summary.length > 500) throw new Error("The edit summary must be 500 characters or fewer");

  const now = new Date();
  const existing = await args.db.execute({
    sql: `select * from "wildwood_work_intent"
      where "project_id" = ? and "requested_by" = ? and "requested_for" = ?
        and "summary" = ? and "status" = 'pending' and "expires_at" > ?
      order by "created_at" desc limit 1`,
    args: [args.project.id, args.requestedBy, args.requestedFor, summary, now.toISOString()],
  });
  const existingRow = rows(existing)[0];
  if (existingRow) return intentFromRow(existingRow);

  const createdAt = now.toISOString();
  const ttlSeconds = Math.min(Math.max(Math.floor(args.ttlSeconds ?? 15 * 60), 60), 60 * 60);
  const intent: WildwoodWorkIntent = {
    id: crypto.randomUUID(),
    requestedBy: args.requestedBy,
    requestedFor: args.requestedFor,
    summary,
    status: "pending",
    createdAt,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  await args.db.execute({
    sql: `insert into "wildwood_work_intent"
      ("id", "project_id", "requested_by", "requested_for", "summary", "status",
       "created_at", "expires_at") values (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [
      intent.id,
      args.project.id,
      intent.requestedBy,
      intent.requestedFor,
      intent.summary,
      intent.createdAt,
      intent.expiresAt,
    ],
  });
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "created_at", "metadata")
      values (?, ?, 'work_intent.requested', ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      args.requestedBy,
      args.requestedFor,
      createdAt,
      JSON.stringify({ intentId: intent.id, summary: intent.summary }),
    ],
  });
  return intent;
}

export async function getWorkIntent(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  intentId: string;
  requestedBy?: string;
}): Promise<WildwoodWorkIntent | null> {
  const result = await args.db.execute({
    sql: `select * from "wildwood_work_intent"
      where "project_id" = ? and "id" = ? ${args.requestedBy ? 'and "requested_by" = ?' : ""}
      limit 1`,
    args: args.requestedBy
      ? [args.project.id, args.intentId, args.requestedBy]
      : [args.project.id, args.intentId],
  });
  const row = rows(result)[0];
  if (!row) return null;
  const intent = intentFromRow(row);
  if (intent.status === "expired" && String(row.status) === "pending") {
    await args.db.execute({
      sql: `update "wildwood_work_intent" set "status" = 'expired' where "id" = ?`,
      args: [intent.id],
    });
  }
  return intent;
}

export async function decideWorkIntent(args: {
  db: WildwoodAccessDb;
  project: WildwoodProject;
  intentId: string;
  actorId: string;
  decision: "approve" | "deny";
  activate: (intent: WildwoodWorkIntent) => Promise<{ ref: string; grantId: string }>;
}): Promise<WildwoodWorkIntent> {
  const intent = await getWorkIntent({
    db: args.db,
    project: args.project,
    intentId: args.intentId,
  });
  if (!intent) throw new Error("Edit intent not found");
  if (intent.requestedFor !== args.actorId) {
    throw new Error("This edit intent belongs to a different user");
  }
  if (intent.status !== "pending") throw new Error(`Edit intent is already ${intent.status}`);

  const decidedAt = new Date().toISOString();
  let ref: string | undefined;
  let grantId: string | undefined;
  if (args.decision === "approve") {
    ({ ref, grantId } = await args.activate(intent));
  }
  const status = args.decision === "approve" ? "approved" : "denied";
  await args.db.execute({
    sql: `update "wildwood_work_intent"
      set "status" = ?, "ref" = ?, "grant_id" = ?, "decided_at" = ?, "decided_by" = ?
      where "id" = ? and "status" = 'pending'`,
    args: [status, ref ?? null, grantId ?? null, decidedAt, args.actorId, intent.id],
  });
  await args.db.execute({
    sql: `insert into "wildwood_auth_event"
      ("id", "project_id", "type", "actor_id", "subject_id", "grant_id", "created_at", "metadata")
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      args.project.id,
      `work_intent.${status}`,
      args.actorId,
      intent.requestedBy,
      grantId ?? null,
      decidedAt,
      JSON.stringify({ intentId: intent.id, ref }),
    ],
  });
  return { ...intent, status, ref, grantId, decidedAt, decidedBy: args.actorId };
}
