import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  ConflictError,
  type ContentEngine,
  type Collections,
  type SqlDatabase,
  type SqlExecutor,
} from "wildwood-core";
import type { Actor } from "./server";
import { mediaType } from "./media";
export type ReviewAuthority = { kind: "native" } | { kind: "external"; label: string };
export type PageContext = { url: string; version: string; variant: Record<string, string> };
export type Change = {
  path: string;
  before: string | null;
  after: string | null;
  beforeMode: string | null;
  afterMode: string | null;
  pages?: PageContext[];
};
export type Revision = {
  id: string;
  snapshot: string;
  base: string;
  baseRevision: number;
  version: string;
  variant: Record<string, string>;
  created: number;
  changes: Change[];
};
type Review = {
  id: string;
  actor: string;
  name: string;
  draft: string;
  title: string;
  ref: string;
  revisions: Revision[];
  status: "open" | "landing" | "published";
  landing?: { revision: string; actor: string };
  published?: string;
};
type Event = {
  id: string;
  actor: string;
  name: string;
  revision: string;
  type: "comment" | "approve" | "request_changes";
  body: string;
  path?: string;
  created: number;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function createReviews<C extends Collections>({
  db,
  cms,
  ready,
  audience,
  authority,
  target,
}: {
  db: SqlDatabase;
  cms: ContentEngine<C>;
  ready: () => Promise<void>;
  audience: string;
  authority: ReviewAuthority;
  target: string;
}) {
  const repository = cms.config.repository;
  let initialization: Promise<void> | undefined;
  async function init() {
    await ready();
    await (initialization ??= db
      .execute(
        "CREATE TABLE IF NOT EXISTS ww_web_review_data (repository TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repository,id))",
      )
      .then(async () => {
        await db.execute(
          "CREATE TABLE IF NOT EXISTS ww_web_edit_context (repository TEXT NOT NULL, ref TEXT NOT NULL, revision INTEGER NOT NULL, path TEXT NOT NULL, context TEXT NOT NULL, snapshot TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(repository,ref,revision,path,context))",
        );
        await db.transaction(async (tx) => {
          const rows = (
            await tx.execute(
              "SELECT data FROM ww_web_review_data WHERE repository=? AND kind='review'",
              [repository],
            )
          ).rows;
          for (const row of rows) {
            const review = JSON.parse(String(row.data)) as Review;
            if (review.status === "published" || review.status === "landing")
              await tx.execute("INSERT OR IGNORE INTO ww2_ref_locks(repository,name) VALUES(?,?)", [
                repository,
                review.ref,
              ]);
          }
        });
      })
      .catch((e) => {
        initialization = undefined;
        throw e;
      }));
  }
  async function read<T>(tx: SqlExecutor, id: string, kind: string): Promise<T | null> {
    const row = (
      await tx.execute(
        "SELECT data FROM ww_web_review_data WHERE repository=? AND id=? AND kind=?",
        [repository, id, kind],
      )
    ).rows[0];
    return row ? JSON.parse(String(row.data)) : null;
  }
  async function write(tx: SqlExecutor, id: string, kind: string, value: unknown) {
    await tx.execute(
      "INSERT INTO ww_web_review_data(repository,id,kind,data) VALUES(?,?,?,?) ON CONFLICT(repository,id) DO UPDATE SET data=excluded.data",
      [repository, id, kind, JSON.stringify(value)],
    );
  }
  async function review(tx: SqlExecutor, id: string) {
    const r = await read<Review>(tx, id, "review");
    if (!r) throw new Error("Review unavailable");
    return r;
  }
  async function permission(tx: SqlExecutor, r: Review, actor: Actor) {
    if (actor.role === "owner") return "approve";
    if (r.actor === actor.id) return "comment";
    const g = await read<{ expires: number; scope: string }>(
      tx,
      `access:${r.id}:${actor.id}`,
      "access",
    );
    if (!g || g.expires < Date.now()) throw new Error("Review access denied");
    return g.scope;
  }
  async function events(tx: SqlExecutor, id: string) {
    return (await read<Event[]>(tx, `events:${id}`, "events")) ?? [];
  }
  function latest(r: Review, id?: string) {
    const rev = id ? r.revisions.find((x) => x.id === id) : r.revisions.at(-1);
    if (!rev) throw new Error("Revision unavailable");
    return rev;
  }
  async function submit(
    actor: Actor,
    args: {
      draft: string;
      ref: string;
      refRevision: number;
      base: string;
      baseRevision: number;
      snapshot: string;
      version: string;
      variant: Record<string, string>;
    },
  ) {
    await init();
    const id = hash(`review:${args.draft}`).slice(0, 24);
    const before = new Map((await cms.files(args.base)).map((f) => [f.path, f]));
    const after = new Map((await cms.files(args.snapshot)).map((f) => [f.path, f]));
    const contexts = (
      await db.execute(
        "SELECT path,context FROM ww_web_edit_context WHERE repository=? AND ref=? AND revision<=? ORDER BY revision",
        [repository, args.ref, args.refRevision],
      )
    ).rows;
    const pages = new Map<string, Map<string, PageContext>>();
    for (const row of contexts) {
      const path = String(row.path);
      if (!pages.has(path)) pages.set(path, new Map());
      pages.get(path)!.set(String(row.context), JSON.parse(String(row.context)));
    }
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .filter(
        (p) =>
          before.get(p)?.blob !== after.get(p)?.blob || before.get(p)?.mode !== after.get(p)?.mode,
      )
      .map((path) => ({
        path,
        before: before.get(path)?.blob ?? null,
        after: after.get(path)?.blob ?? null,
        beforeMode: before.get(path)?.mode ?? null,
        afterMode: after.get(path)?.mode ?? null,
        pages: [...(pages.get(path)?.values() ?? [])],
      }));
    const rid = hash(
      JSON.stringify([args.snapshot, args.base, args.version, args.variant, changes]),
    ).slice(0, 24);
    return db.transaction(async (tx) => {
      let r = await read<Review>(tx, id, "review");
      if (r && r.actor !== actor.id) throw new Error("Review access denied");
      if (r?.status === "landing") throw new Error("Publication is in progress");
      if (r?.status === "published")
        throw new Error("This review was published. Create a new draft.");
      const head = (
        await tx.execute("SELECT snapshot,revision FROM ww2_refs WHERE repository=? AND name=?", [
          repository,
          args.ref,
        ])
      ).rows[0];
      if (head?.snapshot !== args.snapshot || Number(head?.revision) !== args.refRevision)
        throw new ConflictError(
          "Draft advanced while submitting review. Read its latest revision and submit again.",
        );
      if (!r)
        r = {
          id,
          actor: actor.id,
          name: actor.name,
          draft: args.draft,
          ref: args.ref,
          title: "Draft review",
          status: "open",
          revisions: [],
        };
      if (!r.revisions.some((x) => x.id === rid)) {
        r.revisions.push({
          id: rid,
          snapshot: args.snapshot,
          base: args.base,
          baseRevision: args.baseRevision,
          version: args.version,
          variant: args.variant,
          created: Date.now(),
          changes,
        });
        await write(tx, id, "review", r);
      }
      return { id, revision: rid };
    });
  }
  async function get(actor: Actor, id: string, revision?: string) {
    await init();
    const r = await review(db, id);
    const scope = await permission(db, r, actor);
    const rev = latest(r, revision);
    const activity = await events(db, id);
    const decisions = new Map<string, Event>();
    for (const e of activity)
      if (e.revision === rev.id && e.type !== "comment") decisions.set(e.actor, e);
    const approved = [...decisions.values()].some((e) => e.type === "approve");
    const changesRequested = [...decisions.values()].some((e) => e.type === "request_changes");
    const main = await cms.ref(target);
    const head = await cms.ref(r.ref).catch(() => null);
    const stale = main.snapshot !== rev.base || main.revision !== rev.baseRevision;
    const grants =
      actor.role === "owner"
        ? (
            await db.execute(
              "SELECT id,data FROM ww_web_review_data WHERE repository=? AND kind='invite'",
              [repository],
            )
          ).rows
            .map((row) => ({ id: String(row.id), ...JSON.parse(String(row.data)) }))
            .filter((g) => g.review === id && g.expires > Date.now())
            .map((g) => ({
              id: g.id,
              scope: g.scope,
              subject: g.subject ?? null,
              name: g.name ?? null,
              expires: g.expires,
            }))
        : [];
    const handoffs =
      actor.role === "owner"
        ? (
            await db.execute(
              "SELECT id,data FROM ww_web_review_data WHERE repository=? AND kind='landing-grant'",
              [repository],
            )
          ).rows
            .map((row) => ({
              grant: String(row.id).slice("landing-grant:".length),
              ...JSON.parse(String(row.data)),
            }))
            .filter((g) => g.review === id && !g.revoked && g.expires > Date.now())
            .map((g) => ({ grant: g.grant, revision: g.revision, expires: g.expires }))
        : [];
    return {
      handoffs,
      grants,
      ...r,
      revision: rev,
      activity,
      scope,
      actor,
      authority: {
        kind: authority.kind,
        label: authority.kind === "native" ? "Wildwood" : authority.label,
        target,
      },
      requirements: {
        approved,
        changesRequested,
        targetAdvanced: stale,
        newerRevision: rev.id !== latest(r).id,
        unsubmittedChanges: head?.snapshot !== latest(r).snapshot,
      },
      capabilities: {
        updateDraft: r.status === "open" && actor.id === r.actor && actor.role !== "reader",
        comment: r.status === "open",
        approve: scope === "approve" && r.status === "open",
        publish: authority.kind === "native" && actor.role === "owner" && r.status !== "published",
        invite: actor.role === "owner",
      },
    };
  }
  async function file(actor: Actor, id: string, rid: string, path: string) {
    const r = await get(actor, id, rid);
    const change = r.revision.changes.find((c) => c.path === path);
    if (!change) throw new Error("File not in this revision");
    const decode = async (blob: string | null) => {
      if (!blob) return { source: "", binary: false, size: 0 };
      const bytes = await cms.bytes(blob);
      const media = mediaType(bytes);
      if (media.kind !== "file") return { source: null, binary: true, size: bytes.length, media };
      if (bytes.byteLength > 512 * 1024)
        return { source: null, binary: false, size: bytes.byteLength, tooLarge: true };
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return {
          source: source.includes("\0") ? null : source,
          binary: source.includes("\0"),
          size: bytes.byteLength,
        };
      } catch {
        return { source: null, binary: true, size: bytes.byteLength };
      }
    };
    return {
      ...change,
      beforeContent: await decode(change.before),
      afterContent: await decode(change.after),
    };
  }
  async function decide(
    actor: Actor,
    id: string,
    rid: string,
    type: Event["type"],
    body: string,
    path?: string,
    command?: string,
  ) {
    await init();
    const result = {
      message:
        type === "approve"
          ? "Revision approved."
          : type === "request_changes"
            ? "Changes requested."
            : "Comment added.",
    };
    return db.transaction(async (tx) => {
      const r = await review(tx, id);
      const scope = await permission(tx, r, actor);
      const activity = await events(tx, id);
      const eventId = command ? hash(JSON.stringify([actor.id, command])) : randomUUID();
      const previous = activity.find((event) => event.id === eventId);
      if (previous) {
        if (
          previous.revision !== rid ||
          previous.type !== type ||
          previous.body !== body ||
          previous.path !== path
        )
          throw new Error("Review action key already used with different feedback");
        return result;
      }
      if (r.status !== "open") throw new Error("Review is no longer open");
      const rev = latest(r, rid);
      if (type !== "comment" && (scope !== "approve" || latest(r).id !== rid))
        throw new Error("Approval requires the latest revision and reviewer permission");
      if (path && !rev.changes.some((c) => c.path === path))
        throw new Error("File not in this revision");
      activity.push({
        id: eventId,
        actor: actor.id,
        name: actor.name,
        revision: rid,
        type,
        body,
        path,
        created: Date.now(),
      });
      await write(tx, `events:${id}`, "events", activity);
      return result;
    });
  }
  async function publish(actor: Actor, id: string, rid: string) {
    if (authority.kind !== "native")
      throw new Error("Publication is controlled externally; native publication is disabled");
    await init();
    if (actor.role !== "owner") throw new Error("Owner access required to publish");
    await cms.validateReferences(latest(await review(db, id), rid).snapshot);
    await cms.checkpoint(latest(await review(db, id), rid).snapshot);
    const r = await db.transaction(async (tx) => {
      const r = await review(tx, id);
      const rev = latest(r, rid);
      if (r.status === "published") {
        if (r.landing?.revision !== rid) throw new Error("Another revision was published");
        return r;
      }
      if (r.status === "landing") {
        if (r.landing?.revision !== rid || r.landing.actor !== actor.id)
          throw new Error("Another publication is in progress");
        return r;
      }
      if (latest(r).id !== rid) throw new Error("A newer revision needs review");
      const draftHead = (
        await tx.execute("SELECT snapshot FROM ww2_refs WHERE repository=? AND name=?", [
          repository,
          r.ref,
        ])
      ).rows[0];
      if (draftHead?.snapshot !== rev.snapshot)
        throw new Error(
          "Draft has unsubmitted changes. Submit a new review revision before publishing.",
        );
      const decisions = new Map<string, Event>();
      for (const e of await events(tx, id))
        if (e.revision === rid && e.type !== "comment") decisions.set(e.actor, e);
      if (
        ![...decisions.values()].some((e) => e.type === "approve") ||
        [...decisions.values()].some((e) => e.type === "request_changes")
      )
        throw new Error("Approval required; resolve requested changes first");
      const main = await readMain(tx);
      if (main.snapshot !== rev.base || main.revision !== rev.baseRevision)
        throw new Error("Destination advanced. Update the draft before publishing.");
      await tx.execute("INSERT OR IGNORE INTO ww2_ref_locks(repository,name) VALUES(?,?)", [
        repository,
        r.ref,
      ]);
      r.status = "landing";
      r.landing = { revision: rid, actor: actor.id };
      await write(tx, id, "review", r);
      return r;
    });
    if (r.status === "published") return { message: "Snapshot published.", published: r.published };
    const rev = latest(r, rid);
    // The durable reservation blocks new revisions/decisions; the core command is retryable after a crash.
    try {
      const result = await cms.moveRef({
        ref: target,
        snapshot: rev.snapshot,
        expectedSnapshot: rev.base,
        expectedRevision: rev.baseRevision,
        idempotencyKey: `review-land:${id}:${rid}`,
        audit: { actor: actor.id, source: "review" },
      });
      await db.transaction(async (tx) => {
        const current = await review(tx, id);
        current.status = "published";
        current.published = result.snapshot;
        await write(tx, id, "review", current);
      });
      return { message: "Snapshot published.", published: result.snapshot };
    } catch (error) {
      if (error instanceof ConflictError) {
        await db.transaction(async (tx) => {
          const current = await review(tx, id);
          if (current.status === "landing" && current.landing?.revision === rid) {
            await tx.execute("DELETE FROM ww2_ref_locks WHERE repository=? AND name=?", [
              repository,
              current.ref,
            ]);
            current.status = "open";
            delete current.landing;
            await write(tx, id, "review", current);
          }
        });
        throw error;
      }
      throw new Error(
        `Publication not confirmed. Retry this operation to reconcile its result. ${error instanceof Error ? error.message : ""}`,
        { cause: error },
      );
    }
  }
  async function readMain(tx: SqlExecutor) {
    const row = (
      await tx.execute("SELECT snapshot, revision FROM ww2_refs WHERE repository=? AND name=?", [
        repository,
        target,
      ])
    ).rows[0];
    if (!row) throw new Error("Published ref missing");
    return { snapshot: String(row.snapshot), revision: Number(row.revision) };
  }
  async function invite(actor: Actor, id: string, scope: "comment" | "approve", minutes: number) {
    await init();
    if (actor.role !== "owner") throw new Error("Owner access required");
    await review(db, id);
    const token = randomBytes(32).toString("base64url");
    await write(db, `invite:${hash(token)}`, "invite", {
      review: id,
      scope,
      expires: Date.now() + minutes * 60000,
      issuer: actor.id,
    });
    return { token };
  }
  async function claim(actor: Actor, token: string) {
    await init();
    return db.transaction(async (tx) => {
      const key = `invite:${hash(token)}`;
      const invite = await read<{
        review: string;
        scope: string;
        expires: number;
        subject?: string;
        name?: string;
      }>(tx, key, "invite");
      if (!invite || invite.expires < Date.now() || (invite.subject && invite.subject !== actor.id))
        throw new Error("Invitation expired or already claimed");
      invite.subject = actor.id;
      invite.name = actor.name;
      await write(tx, key, "invite", invite);
      await write(tx, `access:${invite.review}:${actor.id}`, "access", {
        grant: key,
        scope: invite.scope,
        expires: invite.expires,
      });
      return invite.review;
    });
  }
  async function revoke(actor: Actor, id: string, grantId: string) {
    await init();
    if (actor.role !== "owner") throw new Error("Owner access required");
    return db.transaction(async (tx) => {
      const g = await read<{ review: string; subject?: string; expires: number }>(
        tx,
        grantId,
        "invite",
      );
      if (!g || g.review !== id) throw new Error("Grant unavailable");
      g.expires = 0;
      await write(tx, grantId, "invite", g);
      if (g.subject) {
        const key = `access:${id}:${g.subject}`;
        const access = await read<{ grant: string; expires: number }>(tx, key, "access");
        if (access?.grant === grantId) {
          access.expires = 0;
          await write(tx, key, "access", access);
        }
      }
      return { message: "Reviewer access revoked." };
    });
  }
  type LandingGrant = {
    review: string;
    revision: string;
    issuer: Actor;
    expires: number;
    audience: string;
    revoked?: boolean;
  };
  async function issueLanding(actor: Actor, id: string, rid: string) {
    const r = await get(actor, id, rid);
    if (
      !r.capabilities.publish ||
      actor.role !== "owner" ||
      r.status !== "open" ||
      r.requirements.newerRevision ||
      r.requirements.targetAdvanced ||
      !r.requirements.approved ||
      r.requirements.changesRequested
    )
      throw new Error("The latest revision must be approved and ready to publish");
    const token = randomBytes(32).toString("base64url");
    const grant = hash(token);
    await write(db, `landing-grant:${grant}`, "landing-grant", {
      review: id,
      revision: rid,
      issuer: actor,
      expires: Date.now() + 600000,
      audience,
    } satisfies LandingGrant);
    return { token, grant, expires: Date.now() + 600000 };
  }
  async function landingGrant(token: string) {
    await init();
    const g = await read<LandingGrant>(db, `landing-grant:${hash(token)}`, "landing-grant");
    if (!g || g.audience !== audience || g.revoked) return null;
    const r = await review(db, g.review);
    // Expiry blocks starting an operation; a reserved/completed operation remains reconcilable.
    if (
      g.expires < Date.now() &&
      !(r.landing?.revision === g.revision && r.landing.actor === g.issuer.id)
    )
      return null;
    return g;
  }
  async function executeLanding(token: string) {
    const g = await landingGrant(token);
    if (!g) throw new Error("Publication grant expired or revoked");
    return publish(g.issuer, g.review, g.revision);
  }
  async function revokeLanding(actor: Actor, id: string, grant: string) {
    await init();
    if (actor.role !== "owner") throw new Error("Owner access required");
    const key = `landing-grant:${grant}`;
    const g = await read<LandingGrant>(db, key, "landing-grant");
    if (!g || g.review !== id) throw new Error("Grant unavailable");
    g.revoked = true;
    await write(db, key, "landing-grant", g);
    return { message: "Publication grant revoked. An operation already in progress may complete." };
  }
  async function recordEdit(
    args: {
      ref: string;
      revision: number;
      snapshot: string;
      path: string;
      actor: string;
      page: PageContext;
    },
    transaction?: SqlExecutor,
  ) {
    // Transaction callers initialized review metadata before acquiring the write lock.
    if (!transaction) await init();
    await (transaction ?? db).execute(
      "INSERT OR IGNORE INTO ww_web_edit_context(repository,ref,revision,path,context,snapshot,actor) VALUES(?,?,?,?,?,?,?)",
      [
        repository,
        args.ref,
        args.revision,
        args.path,
        JSON.stringify(args.page),
        args.snapshot,
        args.actor,
      ],
    );
  }
  return {
    async draftStatus(id: string) {
      await init();
      const r = await read<Review>(db, hash(`review:${id}`).slice(0, 24), "review");
      return r ? { status: r.status, review: r.id } : { status: "open" as const };
    },
    recordEdit,
    submit,
    get,
    file,
    async media(actor: Actor, id: string, rid: string, path: string, side: "before" | "after") {
      const r = await get(actor, id, rid);
      const change = r.revision.changes.find((c) => c.path === path);
      if (
        !change ||
        !change[side] ||
        change[side === "before" ? "beforeMode" : "afterMode"] === "120000"
      )
        throw new Error("Media not in this revision");
      return cms.bytes(change[side]!);
    },
    decide,
    publish,
    invite,
    claim,
    revoke,
    issueLanding,
    landingGrant,
    executeLanding,
    revokeLanding,
  };
}
