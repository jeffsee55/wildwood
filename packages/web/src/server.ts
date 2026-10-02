import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContentEngine, Collections, SqlDatabase, Ref } from "wildwood-core";
import { createReconciliation, resolutionsSchema } from "./reconciliation";
import { draftName } from "./draft-name";
import { pageLocation } from "./page-context";
import { registerContentTools, toolResult, toolError } from "./content-tools";
import { assets } from "./assets.generated";
import { createReviews, type ReviewAuthority } from "./reviews";
import type { ContentMap } from "./sourcemap";
export { withSourcemap, sourcemap } from "./sourcemap";
export { assets };
export type Actor = { id: string; name: string; role: "owner" | "editor" | "reader" };
export type View = {
  version: string;
  variant: Record<string, string>;
  snapshot: string;
  ref: Ref | null;
  mode: "published" | "draft" | "pinned" | "shared";
  actor: Actor | null;
  viewId?: string;
};
type RecordData = Record<string, unknown>;
const text = z.string().min(1).max(4096);
const mapSchema = z.object({
  v: z.literal(1),
  repository: text,
  snapshot: text,
  version: text,
  variant: z.record(z.string(), z.string()),
  source: text,
  canonical: text,
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
});
const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("draft-merge-plan"), id: text }),
  z.object({ type: z.literal("draft-merge-file"), plan: text, path: text }),
  z.object({
    type: z.literal("draft-merge-apply"),
    id: text,
    plan: text,
    command: z.string().min(1).max(200),
    resolutions: resolutionsSchema,
    confirmConflicts: z.boolean().default(false),
  }),
  z.object({ type: z.literal("draft") }),
  z.object({ type: z.literal("resume"), id: text }),
  z.object({ type: z.literal("document"), map: text }),
  z.object({
    type: z.literal("save"),
    map: text,
    source: z.string().max(128 * 1024),
    revision: z.number().int().nonnegative(),
    command: text,
    override: z.boolean().optional(),
    pageUrl: text.optional(),
  }),
  z.object({
    type: z.literal("share"),
    moving: z.boolean().default(false),
    minutes: z.number().int().min(1).max(10080).default(60),
  }),
  z.object({ type: z.literal("revoke"), id: text }),
  z.object({ type: z.literal("review") }),
  z.object({ type: z.literal("publish"), id: text, revision: text }),
  z.object({
    type: z.literal("review-decision"),
    id: text,
    revision: text,
    decision: z.enum(["comment", "approve", "request_changes"]),
    body: z.string().max(10000).default(""),
    path: text.optional(),
  }),
  z.object({
    type: z.literal("review-invite"),
    id: text,
    scope: z.enum(["comment", "approve"]),
    minutes: z.number().int().min(1).max(10080).default(1440),
  }),
  z.object({ type: z.literal("review-claim"), token: text }),
  z.object({ type: z.literal("review-handoff"), id: text, revision: text }),
  z.object({ type: z.literal("review-handoff-revoke"), id: text, grant: text }),
  z.object({ type: z.literal("review-revoke"), id: text, grant: text }),
  z.object({
    type: z.literal("agent"),
    createDrafts: z.boolean().default(true),
    write: z.boolean().default(true),
  }),
  z.object({ type: z.literal("access-request") }),
  z.object({ type: z.literal("grant-editor"), id: text }),
]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
const htmlEscape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function cookie(headers: Headers, name: string) {
  return headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function createWeb<C extends Collections>(options: {
  database: SqlDatabase;
  engines: Record<string, ContentEngine<C>>;
  version: string;
  origin: string;
  base?: string;
  /** Published ref and starting point for every new draft. */
  ref: string;
  variant?: Record<string, string>;
  development?: boolean;
  identity?: {
    providers?: { github: boolean; local: boolean };
    clientName?: (id: string) => Promise<string>;
    userById?: (
      id: string,
    ) => Promise<{ id: string; name: string; email: string; emailVerified: boolean } | null>;
    user: (
      headers: Headers,
    ) => Promise<{ id: string; name: string; email: string; emailVerified: boolean } | null>;
    handler: (r: Request) => Promise<Response>;
    guard?: (
      handler: (r: Request, jwt: Record<string, unknown>) => Promise<Response>,
    ) => (r: Request) => Promise<Response>;
  };
  ownerEmail?: string;
  reviewAuthority?: ReviewAuthority;
  /** Maps physical content files to site routes for pinned review previews. */
  documentUrl?: (path: string) => string | undefined;
}) {
  const db = options.database,
    cms = options.engines[options.version],
    repository = cms.config.repository,
    base = options.base ?? "/cms",
    publishedRef = options.ref;
  if (typeof publishedRef !== "string" || !publishedRef.trim())
    throw new Error("A published ref must be explicitly configured");
  if (new URL(options.origin).origin !== options.origin)
    throw new Error("origin must be a canonical origin");
  if (!/^\/[A-Za-z0-9_/-]+$/.test(base) || base.endsWith("/"))
    throw new Error("Invalid mount path");
  const local = new URL(options.origin).hostname;
  const development =
    options.development === true &&
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(local);
  let initialization: Promise<void> | undefined;
  async function ready() {
    await (initialization ??= (async () => {
      await cms.ready();
      await db.execute(
        "CREATE TABLE IF NOT EXISTS ww_web_records (repository TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT, data TEXT NOT NULL, expires INTEGER, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repository,id))",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS ww_web_records_actor ON ww_web_records(repository,kind,actor)",
      );
      await db.execute(
        "CREATE TABLE IF NOT EXISTS ww_web_rate_limits (repository TEXT NOT NULL, subject TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(repository,subject))",
      );
    })().catch((error) => {
      initialization = undefined;
      throw error;
    }));
  }
  async function put(
    kind: string,
    actor: string | null,
    data: RecordData,
    expires?: number,
    id: string = randomUUID(),
  ) {
    await ready();
    await db.execute(
      "INSERT INTO ww_web_records(repository,id,kind,actor,data,expires) VALUES(?,?,?,?,?,?)",
      [repository, id, kind, actor, JSON.stringify(data), expires ?? null],
    );
    return id;
  }
  async function get(id: string, kind?: string) {
    await ready();
    const row = (
      await db.execute(
        "SELECT * FROM ww_web_records WHERE repository=? AND id=? AND revoked=0 AND (expires IS NULL OR expires>?)",
        [repository, id, Date.now()],
      )
    ).rows[0];
    if (!row || (kind && row.kind !== kind)) return null;
    return {
      id: String(row.id),
      kind: String(row.kind),
      actor: row.actor === null ? null : String(row.actor),
      expires: row.expires === null ? null : Number(row.expires),
      data: JSON.parse(String(row.data)) as RecordData,
    };
  }
  async function list(kind: string, actor?: string) {
    await ready();
    const rows = (
      await db.execute(
        `SELECT * FROM ww_web_records WHERE repository=? AND kind=? AND revoked=0 AND (expires IS NULL OR expires>?) ${actor ? "AND actor=?" : ""} ORDER BY rowid DESC LIMIT 100`,
        actor ? [repository, kind, Date.now(), actor] : [repository, kind, Date.now()],
      )
    ).rows;
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      actor: row.actor === null ? null : String(row.actor),
      expires: row.expires === null ? null : Number(row.expires),
      data: JSON.parse(String(row.data)) as RecordData,
    }));
  }
  async function actor(headers: Headers): Promise<Actor | null> {
    if (development) {
      const token = cookie(headers, "ww-local-session");
      if (token && (await get(digest(token), "local-session")))
        return { id: "local-owner", name: "Local developer", role: "owner" };
    }
    const user = await options.identity?.user(headers);
    if (!user) return null;
    return actorForUser(user);
  }
  async function actorForUser(user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
  }): Promise<Actor> {
    if (
      development &&
      options.identity?.providers?.local &&
      user.email === "local@wildwood.invalid" &&
      user.emailVerified
    )
      return { id: "local-owner", name: user.name, role: "owner" };
    const owner =
      user.emailVerified &&
      options.ownerEmail &&
      user.email.toLowerCase() === options.ownerEmail.toLowerCase();
    const membership = await get(`member:${user.id}`, "member");
    return {
      id: user.id,
      name: user.name,
      role: owner ? "owner" : membership ? "editor" : "reader",
    };
  }
  async function view(
    headers: Headers,
    prefs: { version?: string; variant?: Record<string, string> } = {},
  ): Promise<View> {
    await ready();
    const person = await actor(headers);
    let version = prefs.version && options.engines[prefs.version] ? prefs.version : options.version;
    let variant = prefs.variant ?? options.variant ?? {};
    // Validate even caller-provided preferences; they are query context, never access authority.
    for (const [axis, spec] of Object.entries(cms.config.variants ?? {}))
      if (!spec.options.includes(variant[axis] ?? spec.default)) throw new Error("Unknown variant");
    const selection = cookie(headers, "ww-view");
    const selected = selection ? await get(digest(selection)) : null;
    if (selected?.kind === "draft-view" && person && selected.actor === person.id) {
      const draft = await get(String(selected.data.draft), "draft");
      if (
        draft &&
        draft.actor === person.id &&
        person.role !== "reader" &&
        (await reviews.draftStatus(String(draft.id))).status !== "published"
      ) {
        const ref = await cms.ref(String(draft.data.ref));
        return {
          version,
          variant,
          snapshot: ref.snapshot,
          ref,
          mode: "draft",
          actor: person,
          viewId: String(draft.id),
        };
      }
    }
    if (selected?.kind === "share-session") {
      let share = await get(String(selected.data.share), "share");
      if (share?.data.review) {
        if (!person || share.data.subject !== person.id) share = null;
        else {
          try {
            await reviews.get(person, String(share.data.review));
          } catch {
            share = null;
          }
        }
      }
      if (share) {
        version = String(share.data.version);
        variant = share.data.variant as Record<string, string>;
        if (!options.engines[version])
          throw new Error("This preview schema is no longer available");
        const ref = share.data.ref ? await cms.ref(String(share.data.ref)) : null;
        return {
          version,
          variant,
          snapshot: ref?.snapshot ?? String(share.data.snapshot),
          ref,
          mode: ref ? "shared" : "pinned",
          actor: person,
        };
      }
    }
    const ref = await cms.ref(publishedRef);
    return { version, variant, snapshot: ref.snapshot, ref, mode: "published", actor: person };
  }
  function requireEditor(person: Actor | null): Actor {
    if (!person || person.role === "reader") throw new Error("Sign in with editing access first");
    return person;
  }
  function requireDraft(current: View) {
    requireEditor(current.actor);
    if (current.mode !== "draft" || !current.ref || !current.viewId)
      throw new Error("Open your own draft before editing");
    return current.ref;
  }
  function location(raw: string, current: View): ContentMap {
    const map = mapSchema.parse(JSON.parse(raw));
    const engine = options.engines[current.version];
    if (
      map.repository !== repository ||
      map.snapshot !== current.snapshot ||
      map.version !== engine.config.version ||
      JSON.stringify(Object.entries(map.variant).sort()) !==
        JSON.stringify(
          Object.entries({
            ...Object.fromEntries(
              Object.entries(engine.config.variants ?? {}).map(([key, s]) => [key, s.default]),
            ),
            ...current.variant,
          }).sort(),
        )
    )
      throw new Error("The page is stale or from a different view. Reload before editing.");
    return map;
  }
  const reviews = createReviews({
    db,
    cms,
    ready,
    audience: `${options.origin}${base}/mcp`,
    target: publishedRef,
    authority: options.reviewAuthority ?? { kind: "native" },
  });
  const reconciliation = createReconciliation(cms, publishedRef, ready);
  async function command(current: View, raw: unknown): Promise<RecordData> {
    const input = inputSchema.parse(raw);
    if (input.type === "access-request") {
      if (!current.actor) throw new Error("Sign in first");
      if (!(await list("access", current.actor.id)).length)
        await put("access", current.actor.id, { name: current.actor.name });
      return { message: "Access requested." };
    }
    if (input.type === "review-claim") {
      if (!current.actor) throw new Error("Sign in first");
      return { id: await reviews.claim(current.actor, input.token) };
    }
    if (input.type === "review-decision") {
      if (!current.actor) throw new Error("Sign in first");
      return reviews.decide(
        current.actor,
        input.id,
        input.revision,
        input.decision,
        input.body,
        input.path,
      );
    }
    const person = requireEditor(current.actor);
    if (input.type === "draft-merge-plan") return reconciliation.plan(person, input.id);
    if (input.type === "draft-merge-file")
      return reconciliation.file(person, input.plan, input.path);
    if (input.type === "draft-merge-apply") {
      const stored = await get(input.plan, "merge-plan");
      if (!stored || stored.data.draft !== input.id)
        throw new Error("Merge plan outside draft scope");
      const result = await reconciliation.apply(person, input);
      const draft = await get(input.id, "draft");
      if (!draft || draft.data.ref !== result.name)
        throw new Error("Draft does not match merge plan");
      const submitted = await reviews.submit(person, {
        draft: input.id,
        ref: result.name,
        refRevision: result.revision,
        base: String((stored.data.target as Ref).snapshot),
        baseRevision: Number((stored.data.target as Ref).revision),
        snapshot: result.snapshot,
        version: options.version,
        variant: options.variant ?? {},
      });
      return {
        ...result,
        review: submitted.id,
        reviewRevision: submitted.revision,
        message: "Draft updated with Git. Review and approve the new revision.",
      };
    }
    if (input.type === "grant-editor") {
      if (person.role !== "owner") throw new Error("Owner access required");
      const request = await get(input.id, "access");
      if (!request) throw new Error("Unknown access request");
      await db.execute(
        "INSERT OR IGNORE INTO ww_web_records(repository,id,kind,actor,data) VALUES(?,?,?,?,?)",
        [repository, `member:${request.actor}`, "member", String(request.actor), "{}"],
      );
      await db.execute("UPDATE ww_web_records SET revoked=1 WHERE repository=? AND id=?", [
        repository,
        input.id,
      ]);
      return { message: "Editing access granted." };
    }
    if (input.type === "draft") {
      if (current.mode === "pinned" || current.mode === "shared")
        throw new Error("Return to published content before creating a draft");
      const main = await cms.ref(publishedRef);
      const ref = await cms.branch(`draft/${randomUUID()}`, { snapshot: main.snapshot });
      const id = await put("draft", person.id, {
        ref: ref.name,
        name: draftName(ref.name),
        base: main.snapshot,
        baseRevision: main.revision,
        created: Date.now(),
      });
      const token = secret();
      await put("draft-view", person.id, { draft: id }, Date.now() + 86400_000, digest(token));
      return { viewToken: token, message: "Draft created.", refresh: true };
    }
    if (input.type === "resume") {
      const draft = await get(input.id, "draft");
      if (!draft || draft.actor !== person.id) throw new Error("Draft not available");
      if ((await reviews.draftStatus(input.id)).status !== "open")
        throw new Error("Completed drafts are read-only. Create a new draft.");
      const token = secret();
      await put(
        "draft-view",
        person.id,
        { draft: input.id },
        Date.now() + 86400_000,
        digest(token),
      );
      return { viewToken: token, refresh: true };
    }
    if (input.type === "revoke") {
      const record = await get(input.id);
      if (
        !record ||
        !["share", "agent", "oauth-agent"].includes(String(record.kind)) ||
        (record.actor !== person.id && person.role !== "owner")
      )
        throw new Error("Access denied");
      await db.execute("UPDATE ww_web_records SET revoked=1 WHERE repository=? AND id=?", [
        repository,
        input.id,
      ]);
      return { message: "Access revoked." };
    }
    if (input.type === "publish") return reviews.publish(person, input.id, input.revision);
    if (input.type === "review-handoff")
      return {
        ...(await reviews.issueLanding(person, input.id, input.revision)),
        endpoint: `${options.origin}${base}/mcp`,
      };
    if (input.type === "review-handoff-revoke")
      return reviews.revokeLanding(person, input.id, input.grant);
    if (input.type === "review-revoke") return reviews.revoke(person, input.id, input.grant);
    if (input.type === "review-invite") {
      const result = await reviews.invite(person, input.id, input.scope, input.minutes);
      return {
        url: `${options.origin}${base}/review?invite=${result.token}`,
        message: "Invitation created. It can be claimed by one signed-in reviewer.",
      };
    }
    const ref = requireDraft(current);
    if ((await reviews.draftStatus(current.viewId!)).status !== "open")
      throw new Error("This draft is read-only. Create a new draft.");
    if (input.type === "document" || input.type === "save") {
      const map = location(input.map, current);
      cms.collectionFor(map.source);
      const file = (await cms.files(current.snapshot)).find((f) => f.path === map.source);
      if (!file || file.mode === "120000") throw new Error("Source file unavailable");
      if (input.type === "document")
        return {
          source: new TextDecoder().decode(await cms.bytes(file.blob)),
          revision: ref.revision,
          map: JSON.stringify(map),
          path: map.source,
          field: map.path.join("."),
          fallback:
            map.source === map.canonical &&
            Object.entries(current.variant).some(
              ([k, v]) => v !== cms.config.variants?.[k]?.default,
            ),
        };
      let path = map.source;
      if (input.override) {
        path = map.canonical;
        for (const [axis, spec] of Object.entries(cms.config.variants ?? {})) {
          const value = current.variant[axis] ?? spec.default;
          if (value === spec.default) continue;
          if (spec.path !== "suffix")
            throw new Error("Creating folder overrides is not supported by this editor yet");
          const dot = path.lastIndexOf(".");
          path = `${path.slice(0, dot)}.${value}${path.slice(dot)}`;
        }
        if (path === map.source) throw new Error("This is already the selected variant");
        if ((await cms.files(current.snapshot)).some((f) => f.path === path))
          throw new Error("An override already exists; reload to select it");
      }
      const pageUrl = input.pageUrl ? pageLocation(input.pageUrl, options.origin) : undefined;
      const saved = await cms.apply({
        ref: ref.name,
        expectedRevision: input.revision,
        idempotencyKey: `web:${person.id}:${input.command}`,
        changes: [{ path, content: input.source }],
        audit: { actor: person.id, source: "editor" },
      });
      if (pageUrl)
        await reviews.recordEdit({
          ref: ref.name,
          revision: saved.revision,
          snapshot: saved.snapshot,
          path,
          actor: person.id,
          page: { url: pageUrl, version: current.version, variant: current.variant },
        });
      return { message: "Saved. The server is rendering the updated page.", refresh: true };
    }
    if (input.type === "share") {
      const token = secret(),
        exp = Date.now() + input.minutes * 60_000;
      const id = await put(
        "share",
        person.id,
        {
          ...(input.moving ? { ref: ref.name } : { snapshot: ref.snapshot }),
          version: current.version,
          variant: current.variant,
          created: Date.now(),
        },
        exp,
        digest(token),
      );
      return {
        url: `${options.origin}${base}/preview?token=${token}`,
        id,
        message: input.moving ? "Moving draft link created." : "Pinned preview link created.",
      };
    }
    if (input.type === "agent") {
      const token = secret();
      const id = await put(
        "agent",
        person.id,
        {
          ref: ref.name,
          draft: current.viewId,
          version: current.version,
          variant: current.variant,
          write: input.write,
          createDrafts: input.createDrafts,
          audience: `${options.origin}${base}/mcp`,
        },
        undefined,
        digest(token),
      );
      return {
        token,
        id,
        endpoint: `${options.origin}${base}/mcp`,
        message: "This credential is shown once. Keep it private.",
      };
    }
    if (input.type === "review") {
      const draft = await get(current.viewId!, "draft");
      if (!draft) throw new Error("Draft missing");
      const result = await reviews.submit(person, {
        draft: draft.id,
        ref: ref.name,
        refRevision: ref.revision,
        base: String(draft.data.base),
        baseRevision: Number(draft.data.baseRevision),
        snapshot: ref.snapshot,
        version: current.version,
        variant: current.variant,
      });
      return {
        ...result,
        url: `${options.origin}${base}/review?id=${result.id}`,
        message: "Review updated for this exact snapshot.",
      };
    }
    throw new Error("Unsupported command");
  }
  async function state(current: View) {
    const drafts = current.actor
      ? await Promise.all(
          (await list("draft", current.actor.id)).map(async (draft) => {
            const row = (
              await db.execute(
                "SELECT s.created_at FROM ww2_refs r JOIN ww2_snapshots s ON s.id=r.snapshot WHERE r.repository=? AND r.name=?",
                [repository, String(draft.data.ref)],
              )
            ).rows[0];
            const updatedAt = Math.max(
              Number(draft.data.created),
              Date.parse(String(row?.created_at)) || 0,
            );
            return {
              ...draft,
              ...(await reviews.draftStatus(String(draft.id))),
              updatedAt,
              data: {
                ...draft.data,
                created: Number(draft.data.created),
                name: draft.data.name ?? draftName(String(draft.data.ref)),
              },
            };
          }),
        )
      : [];
    return {
      endpoint: base,
      mcpUrl: `${options.origin}${base}/mcp`,
      oauth: !!options.identity?.guard,
      css: `${base}/assets/${assets["toolbar.css"].path}`,
      mode: current.mode,
      snapshot: current.snapshot,
      actor: current.actor,
      version: current.version,
      variant: current.variant,
      canEdit: current.mode === "draft" && !!current.actor && current.actor.role !== "reader",
      drafts: drafts
        .filter((d) => d.status !== "published")
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
      completed: drafts
        .filter((d) => d.status === "published")
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
    };
  }
  function sameOrigin(request: Request) {
    if (request.headers.get("origin") !== options.origin)
      throw new Error("Cross-origin request rejected");
  }
  function page(title: string, body: string, data: RecordData = {}) {
    const serialized = JSON.stringify({ endpoint: base, ...data }).replaceAll("<", "\\u003c");
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)} — Wildwood</title><link rel="stylesheet" href="${base}/assets/${assets["admin.css"].path}"><body><main><a href="/">← Back to site</a><h1>${htmlEscape(title)}</h1>${body}<p role="status" id="status"></p></main><script type="application/json" id="context">${serialized}</script><script type="module" src="${base}/assets/${assets["admin.js"].path}"></script></body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "same-origin",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        },
      },
    );
  }
  async function handler(request: Request): Promise<Response> {
    try {
      const incoming = new URL(request.url);
      // Framework rewrites can preserve the incoming URL on Request. Normalize only
      // our exact path-scoped discovery URLs before dispatching to the provider.
      const discovery =
        incoming.pathname === `/.well-known/oauth-protected-resource${base}/mcp`
          ? `${base}/.well-known/oauth-protected-resource`
          : incoming.pathname === `/.well-known/oauth-authorization-server${base}/auth`
            ? `${base}/auth/.well-known/oauth-authorization-server`
            : null;
      if (discovery) request = new Request(new URL(discovery, options.origin), request);
      const url = new URL(request.url),
        path = url.pathname.slice(base.length);
      if (!url.pathname.startsWith(`${base}/`)) return json({ error: "Not found" }, 404);
      if (path.startsWith("/assets/")) {
        const asset = Object.values(assets).find((a) => path === `/assets/${a.path}`);
        if (!asset || !["GET", "HEAD"].includes(request.method))
          return json({ error: "Not found" }, 404);
        const etag = `"${asset.path.split("/")[0]}"`;
        const headers = {
          "Content-Type": asset.type,
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
        };
        if (request.headers.get("if-none-match") === etag)
          return new Response(null, { status: 304, headers });
        return new Response(request.method === "HEAD" ? null : asset.body, { headers });
      }
      if (path === "/health" && request.method === "GET") {
        await ready();
        await cms.ref(publishedRef);
        const signin = !!options.identity?.providers?.github || development;
        return json({
          status: signin ? "ready" : "configuration_required",
          database: "ready",
          git: await (await import("wildwood-core/git")).gitVersion(),
          authentication: signin ? "configured" : "missing_provider",
          mcp: `${options.origin}${base}/mcp`,
        });
      }
      if (path === "/connect" && request.method === "GET") {
        const endpoint = `${options.origin}${base}/mcp`;
        const configured = !!options.identity?.providers?.github || development;
        const config = JSON.stringify({ mcpServers: { wildwood: { url: endpoint } } }, null, 2);
        return page(
          "Connect your agent",
          `<p>Give your agent a content workspace with drafts, validation, previews and human review.</p><h2>Connection</h2><p><code>${htmlEscape(endpoint)}</code></p><p>${configured ? "Sign-in credentials are configured. Complete sign-in to verify that they work. Add this URL to an OAuth-capable MCP client, then sign in and choose its permissions." : "Sign-in is not configured. Set the GitHub client ID and secret before connecting."}</p><pre>${htmlEscape(config)}</pre><h2>First task</h2><p>Ask your agent: “Discover the content model, create a draft, improve a page, validate it, and give me a preview and review link.”</p><p>Agents can edit authorized drafts. Publishing requires approval of the exact revision.</p><p><a href="${base}/sign-in">Sign in</a> · <a href="${base}/access">Manage access</a> · <a href="${base}/health">Connection health</a></p>`,
        );
      }
      if (path === "/status" && request.method === "GET") {
        const current = await view(request.headers);
        if (!current.actor) return json({ error: "Sign in first" }, 401);
        const result = current.ref
          ? await db.execute(
              "SELECT actor,source,paths,created_at FROM ww2_events WHERE repository=? AND ref=? ORDER BY revision DESC, created_at DESC LIMIT 1",
              [repository, current.ref.name],
            )
          : null;
        return json({
          snapshot: current.snapshot,
          mode: current.mode,
          activity: result?.rows[0] ?? null,
        });
      }
      if (path === "/auth/oauth2/consent" && request.method === "POST" && options.identity) {
        sameOrigin(request);
        const body = z
          .object({
            accept: z.boolean(),
            scope: z.string().optional(),
            oauth_query: z.string(),
            draft: z.string().optional(),
          })
          .parse(await request.json());
        const user = await options.identity.user(request.headers);
        if (!user) return json({ error: "Sign in first" }, 401);
        const person = await actorForUser(user);
        const scopes = (body.scope ?? "").split(" ").filter(Boolean);
        if (body.accept && scopes.some((s) => s === "content:write" || s === "drafts:create"))
          requireEditor(person);
        const draft = body.draft ? await get(body.draft, "draft") : null;
        if (body.accept && body.draft && (!draft || draft.actor !== person.id))
          return json({ error: "Draft unavailable" }, 403);
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        const response = await options.identity.handler(
          new Request(request.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              accept: body.accept,
              scope: body.scope,
              oauth_query: body.oauth_query,
            }),
          }),
        );
        if (response.ok && body.accept) {
          const result = await response.clone().json();
          const destination = result.redirect_uri ?? result.url;
          if (
            typeof destination === "string" &&
            !new URL(destination, options.origin).searchParams.has("error")
          ) {
            const clientId = new URLSearchParams(body.oauth_query).get("client_id");
            if (!clientId) throw new Error("OAuth client missing");
            const id = `oauth:${digest(JSON.stringify([user.id, clientId]))}`;
            const data = {
              clientId,
              name: (await options.identity.clientName?.(clientId)) ?? clientId,
              draft: draft?.id,
              ref: draft?.data.ref,
              version: options.version,
              variant: options.variant ?? {},
              read: scopes.includes("content:read"),
              write: scopes.includes("content:write"),
              createDrafts: scopes.includes("drafts:create"),
              audience: `${options.origin}${base}/mcp`,
              approvedAt: Date.now(),
            };
            await db.execute(
              "INSERT INTO ww_web_records(repository,id,kind,actor,data) VALUES(?,?,?,?,?) ON CONFLICT(repository,id) DO UPDATE SET data=excluded.data,revoked=0",
              [repository, id, "oauth-agent", person.id, JSON.stringify(data)],
            );
          }
        }
        return response;
      }
      if (path.startsWith("/auth/"))
        return options.identity
          ? options.identity.handler(request)
          : json({ error: "No identity provider configured" }, 503);
      if (path === "/.well-known/oauth-protected-resource")
        return json({
          resource: `${options.origin}${base}/mcp`,
          authorization_servers: options.identity ? [`${options.origin}${base}/auth`] : [],
          bearer_methods_supported: ["header"],
          scopes_supported: ["content:read", "content:write", "drafts:create"],
        });
      if (path === "/mcp") return mcpRequest(request);
      if (path === "/local-login" && request.method === "POST") {
        sameOrigin(request);
        if (!development) return json({ error: "Not found" }, 404);
        const token = secret();
        await put("local-session", "local-owner", {}, Date.now() + 8 * 3600_000, digest(token));
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": `ww-local-session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "/logout" && request.method === "POST") {
        sameOrigin(request);
        const token = cookie(request.headers, "ww-local-session");
        if (token)
          await db.execute("UPDATE ww_web_records SET revoked=1 WHERE repository=? AND id=?", [
            repository,
            digest(token),
          ]);
        const headers = new Headers({ "Cache-Control": "no-store" });
        headers.append(
          "Set-Cookie",
          "ww-local-session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        );
        headers.append("Set-Cookie", "ww-view=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        return new Response("{}", { headers });
      }
      if (path === "/preview" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const grant = token ? await get(digest(token), "share") : null;
        if (!grant)
          return new Response("This preview link has expired or been revoked.", {
            status: 403,
            headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
          });
        const session = secret();
        await put(
          "share-session",
          null,
          { share: grant.id },
          Number(grant.expires),
          digest(session),
        );
        const secure = options.origin.startsWith("https:") ? "; Secure" : "";
        return new Response(null, {
          status: 303,
          headers: {
            Location: grant.data.returnTo
              ? pageLocation(String(grant.data.returnTo), options.origin)
              : "/",
            "Set-Cookie": `ww-view=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor((Number(grant.expires) - Date.now()) / 1000)}${secure}`,
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (path === "/sign-in") {
        const error = url.searchParams.get("error");
        const message = !error
          ? ""
          : error === "access_denied"
            ? "Sign-in was canceled. You can try again when you’re ready."
            : "Sign-in could not be completed. Try again. If it keeps failing, ask the site owner to check the GitHub sign-in configuration. If you started from an agent, reconnect there to begin a fresh request.";
        return page(
          "Sign in",
          `${message ? `<p role="alert">${message}</p>` : ""}${development ? (options.identity?.providers?.local ? '<p>Development only: sign in as the local owner.</p><button id="local-oauth">Continue as local developer</button>' : `<form method="post" action="${base}/local-login"><button>Continue as local developer</button></form>`) : ""}${options.identity?.providers?.github ? '<button id="github">Continue with GitHub</button>' : ""}${!development && !options.identity?.providers?.github ? "<p>No sign-in provider configured.</p>" : ""}`,
        );
      }
      if (path === "/consent") {
        const user = await options.identity?.user(request.headers);
        if (!user)
          return new Response(null, {
            status: 303,
            headers: { Location: `${base}/sign-in${url.search}`, "Cache-Control": "no-store" },
          });
        const person = await actorForUser(user);
        const requested = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
        const drafts =
          person.role !== "reader"
            ? (await list("draft", person.id)).filter((d) => !!d.data.ref)
            : [];
        const labels: Record<string, string> = {
          "content:read": "Read published content",
          "content:write": "Edit authorized drafts",
          "drafts:create": "Create drafts",
          offline_access: "Stay connected",
          openid: "Identify your account",
          profile: "Read your profile",
          email: "Read your email address",
        };
        return page(
          "Connect your agent",
          `<p>Client <code>${htmlEscape((await options.identity?.clientName?.(url.searchParams.get("client_id") ?? "")) ?? url.searchParams.get("client_id") ?? "")}</code></p><p>Choose what this agent can do. It cannot approve or publish changes.</p>${requested.map((scope) => `<label class="choice"><input type="checkbox" data-scope="${htmlEscape(scope)}" ${person.role === "reader" && ["content:write", "drafts:create"].includes(scope) ? "disabled" : "checked"}> ${htmlEscape(labels[scope] ?? scope)}</label>`).join("")}${drafts.length ? `<label>Existing draft (optional)<select id="oauth-draft"><option value="">Only drafts this connection creates</option>${drafts.map((d) => `<option value="${htmlEscape(d.id)}">${htmlEscape(String(d.data.name ?? draftName(String(d.data.ref))))}</option>`).join("")}</select></label>` : ""}<p>You can disconnect this agent in Manage access.</p><button id="consent">Connect agent</button><button id="deny-consent">Cancel</button>`,
        );
      }
      const current = await view(request.headers);
      if (!current.actor)
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${base}/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`,
            "Cache-Control": "no-store",
          },
        });
      if (path === "/command" && request.method === "POST") {
        sameOrigin(request);
        const raw = await request.text();
        if (raw.length > 256 * 1024) return json({ error: "Request too large" }, 413);
        const input = JSON.parse(raw);
        // Backend pages manage access/review only. In-page content writes must use the RSC action bridge.
        if (
          ![
            "revoke",
            "grant-editor",
            "access-request",
            "publish",
            "review-decision",
            "review-invite",
            "review-claim",
            "review-revoke",
            "review-handoff",
            "review-handoff-revoke",
            "draft-merge-plan",
            "draft-merge-file",
            "draft-merge-apply",
          ].includes(input.type)
        )
          return json({ error: "Use the site Server Action for content commands" }, 400);
        return json({ ok: true, ...(await command(current, input)) });
      }
      if (path === "/device") {
        if (!options.identity)
          return page(
            "Device authorization",
            "<p>Configure an identity provider to enable device sign-in.</p>",
          );
        return page(
          "Device authorization",
          `<p>Enter the code shown by the device you are signing in. This signs in the device; draft editing still requires explicit scoped access.</p><label>Device code <input id="device-code" value="${htmlEscape(url.searchParams.get("user_code") ?? "")}" autocomplete="off"></label><button id="device-approve">Approve device</button><button id="device-deny">Deny</button>`,
        );
      }
      if (path === "/access") {
        const person = current.actor;
        const records =
          person.role === "reader"
            ? []
            : [
                ...(await list("share", person.id)),
                ...(await list("agent", person.id)),
                ...(await list("oauth-agent", person.id)),
              ];
        const requests = person.role === "owner" ? await list("access") : [];
        return page(
          "Access",
          `<p>Signed in as ${htmlEscape(person.name)} · ${person.role}</p>${person.role === "reader" ? '<button data-command="access-request">Request editing access</button>' : ""}<h2>Shared previews and connected agents</h2>${records.length ? records.map((r) => `<section><p>${htmlEscape(String(r.kind))} · ${htmlEscape(String(r.data.name ?? r.data.ref ?? r.data.snapshot ?? "Agent connection"))}</p><p>${r.expires === null ? (r.data.createDrafts ? "No expiry · until revoked" : "No expiry · until revoked or draft completed") : `Expires ${new Date(Number(r.expires)).toISOString()}`}</p><button data-command="revoke" data-id="${htmlEscape(String(r.id))}">Revoke</button></section>`).join("") : "<p>No active shared access.</p>"}${requests.length ? "<h2>Access requests</h2>" + requests.map((r) => `<section><p>${htmlEscape(String(r.data.name))}</p><button data-command="grant-editor" data-id="${htmlEscape(String(r.id))}">Grant editing access</button></section>`).join("") : ""}<button id="logout">Sign out</button>`,
        );
      }
      if (path === "/review/preview" && request.method === "GET") {
        const result = await reviews.get(
          current.actor,
          url.searchParams.get("id") ?? "",
          url.searchParams.get("revision") ?? undefined,
        );
        const pageIndex = url.searchParams.get("page");
        const page =
          pageIndex !== null && /^\d+$/.test(pageIndex)
            ? result.revision.changes.find((c) => c.path === url.searchParams.get("path"))?.pages?.[
                Number(pageIndex)
              ]
            : undefined;
        if (pageIndex !== null && !page)
          throw new Error("Page is not associated with this reviewed file");
        const token = secret();
        await put(
          "share",
          current.actor.id,
          {
            snapshot:
              url.searchParams.get("side") === "before"
                ? result.revision.base
                : result.revision.snapshot,
            version: page?.version ?? result.revision.version,
            variant: page?.variant ?? result.revision.variant,
            ...(page ? { returnTo: pageLocation(page.url, options.origin) } : {}),
            review: result.id,
            subject: current.actor.id,
          },
          Date.now() + 600000,
          digest(token),
        );
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${base}/preview?token=${token}`,
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (path === "/review/data" && request.method === "GET") {
        return json(
          await reviews.get(
            current.actor,
            url.searchParams.get("id") ?? "",
            url.searchParams.get("revision") ?? undefined,
          ),
        );
      }
      if (path === "/review/file" && request.method === "GET") {
        return json(
          await reviews.file(
            current.actor,
            url.searchParams.get("id") ?? "",
            url.searchParams.get("revision") ?? "",
            url.searchParams.get("path") ?? "",
          ),
        );
      }
      if (path === "/review") {
        const context = JSON.stringify({
          endpoint: base,
          id: url.searchParams.get("id"),
          invite: url.searchParams.get("invite"),
        }).replaceAll("<", "\\u003c");
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review — Wildwood</title><link rel="stylesheet" href="${base}/assets/${assets["review.css"].path}"><body><div id="review-root"></div><script id="context" type="application/json">${context}</script><script type="module" src="${base}/assets/${assets["review.js"].path}"></script></body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "private, no-store",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            },
          },
        );
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : "Request failed" },
        400,
      );
    }
  }
  async function activeAgent(token: string) {
    const grant = await get(digest(token), "agent");
    if (!grant) return null;
    if (grant.data.createDrafts) return grant;
    if (grant.data.draft && (await reviews.draftStatus(String(grant.data.draft))).status !== "open")
      return null;
    const locked = await db.execute(
      "SELECT name FROM ww2_ref_locks WHERE repository=? AND name=?",
      [repository, String(grant.data.ref)],
    );
    return locked.rows.length ? null : grant;
  }
  async function mcpRequest(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    if (origin && origin !== options.origin)
      return json({ error: "Cross-origin MCP request rejected" }, 403);
    if (request.method === "POST") {
      // Bound the stream as well as Content-Length; chunked bodies are not exempt.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 1024 * 1024) {
            await reader.cancel();
            return json({ error: "MCP request exceeds 1 MiB" }, 413);
          }
          chunks.push(next.value);
        }
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "");
    let delegated = bearer ? await activeAgent(bearer) : null;
    const landing = bearer ? await reviews.landingGrant(bearer) : null;
    if (landing && bearer) {
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { WebStandardStreamableHTTPServerTransport } =
        await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
      const server = new McpServer({ name: "wildwood-review", version: "0.0.1" });
      server.registerTool(
        "get_review",
        {
          description: "Inspect the exact review authorized by this publication grant.",
          inputSchema: {},
        },
        async () => {
          const g = await reviews.landingGrant(bearer);
          if (!g) throw new Error("Grant expired or revoked");
          const r = await reviews.get(g.issuer, g.review, g.revision);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: r.id,
                  revision: r.revision.id,
                  status: r.status,
                  requirements: r.requirements,
                }),
              },
            ],
          };
        },
      );
      server.registerTool(
        "publish_review",
        {
          description:
            "Publish only the approved immutable revision authorized by this grant. Retries reconcile the same operation.",
          inputSchema: {},
        },
        async () => ({
          content: [{ type: "text", text: JSON.stringify(await reviews.executeLanding(bearer)) }],
        }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    }
    let credentialId = bearer ? digest(bearer) : "";
    let currentGrant = async () => (bearer ? activeAgent(bearer) : null);
    const serve = async (grant: RecordData | null) => {
      const window = Math.floor(Date.now() / 60_000);
      const rate = await db.execute(
        "INSERT INTO ww_web_rate_limits(repository,subject,window,count) VALUES(?,?,?,1) ON CONFLICT(repository,subject) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END, window=excluded.window RETURNING count",
        [repository, credentialId, window],
      );
      if (Number(rate.rows[0].count) > 120)
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Retry in one minute." }),
          {
            status: 429,
            headers: {
              "Retry-After": "60",
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
        );
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { WebStandardStreamableHTTPServerTransport } =
        await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
      const server = new McpServer({ name: "wildwood", version: "0.0.1" });
      const refName = grant?.ref ? String(grant.ref) : publishedRef;
      const version = grant ? String(grant.version) : options.version;
      const engine = options.engines[version];
      const draftInput = {
        draft: z
          .string()
          .optional()
          .describe(
            "Draft ID returned by create_draft or list_drafts; omit for the starting draft",
          ),
      };
      const authorizedRef = async (draft?: string) => {
        if (!draft) return refName;
        if (draft === grant?.draft) return refName;
        if (!bearer || !grant?.createDrafts) throw new Error("Draft outside credential scope");
        const link = await get(`agent-draft:${credentialId}:${draft}`, "agent-draft");
        if (!link) throw new Error("Draft outside credential scope");
        return String(link.data.ref);
      };
      if (grant?.createDrafts && delegated && bearer) {
        server.registerTool(
          "create_draft",
          {
            description:
              "Create a draft from the configured published ref. Reuse the same command key to retry. Use the returned draft ID with content tools.",
            inputSchema: {
              command: z.string().min(1).max(200),
              name: z.string().min(1).max(120).optional().describe("Human-readable draft name"),
            },
          },
          async ({ command: key, name }) => {
            if (!(await currentGrant())) throw new Error("Credential revoked");
            const draft = digest(`draft:${credentialId}:${key}`);
            const linkId = `agent-draft:${credentialId}:${draft}`;
            const result = await db.transaction(async (tx) => {
              const existing = (
                await tx.execute("SELECT data FROM ww_web_records WHERE repository=? AND id=?", [
                  repository,
                  linkId,
                ])
              ).rows[0];
              if (existing) {
                const result = JSON.parse(String(existing.data));
                if ((result.requestedName ?? null) !== (name ?? null))
                  throw new Error("Command key already used with a different draft name");
                return result;
              }
              const credential = (
                await tx.execute(
                  "SELECT id FROM ww_web_records WHERE repository=? AND id=? AND revoked=0 AND (expires IS NULL OR expires>?)",
                  [repository, credentialId, Date.now()],
                )
              ).rows[0];
              if (!credential) throw new Error("Credential revoked");
              const source = (
                await tx.execute(
                  "SELECT snapshot,revision FROM ww2_refs WHERE repository=? AND name=?",
                  [repository, publishedRef],
                )
              ).rows[0];
              if (!source) throw new Error("Published ref unavailable");
              const ref = `draft/${draft}`;
              const data = {
                ref,
                name: name ?? draftName(ref),
                base: String(source.snapshot),
                baseRevision: Number(source.revision),
                created: Date.now(),
              };
              await tx.execute(
                "INSERT INTO ww2_refs(repository,name,snapshot,revision) VALUES(?,?,?,0)",
                [repository, ref, String(source.snapshot)],
              );
              await tx.execute(
                "INSERT INTO ww_web_records(repository,id,kind,actor,data) VALUES(?,?,?,?,?)",
                [repository, draft, "draft", delegated!.actor, JSON.stringify(data)],
              );
              const result = {
                draft,
                ref,
                name: data.name,
                requestedName: name ?? null,
                snapshot: data.base,
                revision: 0,
              };
              await tx.execute(
                "INSERT INTO ww_web_records(repository,id,kind,actor,data) VALUES(?,?,?,?,?)",
                [repository, linkId, "agent-draft", credentialId, JSON.stringify(result)],
              );
              return result;
            });
            return toolResult(result);
          },
        );
        server.registerTool(
          "list_drafts",
          {
            description: "List the starting draft and drafts created by this credential",
            inputSchema: {},
          },
          async () => {
            if (!(await currentGrant())) throw new Error("Credential revoked");
            const ids = [
              ...(grant.draft ? [String(grant.draft)] : []),
              ...(await list("agent-draft", credentialId)).map((r) => String(r.data.draft)),
            ];
            const drafts = await Promise.all(
              ids.map(async (id) => {
                const d = await get(id, "draft");
                if (!d) return null;
                return {
                  draft: id,
                  ...(await cms.ref(String(d.data.ref))),
                  name: d.data.name ?? draftName(String(d.data.ref)),
                  ref: String(d.data.ref),
                  ...(await reviews.draftStatus(id)),
                };
              }),
            );
            return { content: [{ type: "text", text: JSON.stringify(drafts.filter(Boolean)) }] };
          },
        );
      }
      if (grant?.write && grant.read !== false && delegated) {
        const merges = createReconciliation(engine, publishedRef, ready);
        const mergeActor: Actor = { id: delegated.actor!, name: "Agent", role: "editor" };
        const mergeDraft = async (selected?: string) => {
          const active = await currentGrant();
          if (!active?.data.write || active.data.read === false)
            throw new Error("Credential revoked or missing permission");
          const id = selected ?? String(grant.draft ?? "");
          if (!id) throw new Error("Select an authorized draft first");
          await authorizedRef(id);
          return id;
        };
        for (const operation of ["plan", "file", "apply"] as const) {
          server.registerTool(
            operation === "plan"
              ? "get_draft_update"
              : operation === "file"
                ? "read_merge_conflict"
                : "update_draft",
            {
              description:
                operation === "plan"
                  ? "Use native Git to plan merging published content into your agent branch. Does not change the draft. Returns a pinned plan and Git conflicts."
                  : operation === "file"
                    ? "Read base, draft, published and Git conflict-marker source for a conflicted path in an authorized plan."
                    : "Apply a pinned Git merge plan. Resolve every conflicted path using draft (ours), published (theirs), custom source or deletion. Confirm Git conflict messages. Requires a fresh review afterward; never publishes.",
              inputSchema: {
                ...draftInput,
                ...(operation !== "plan" ? { plan: z.string().min(1) } : {}),
                ...(operation === "file" ? { path: z.string().min(1) } : {}),
                ...(operation === "apply"
                  ? {
                      command: z.string().min(1).max(200),
                      resolutions: resolutionsSchema.default([]),
                      confirmConflicts: z.boolean().default(false),
                    }
                  : {}),
              },
              annotations: {
                readOnlyHint: operation !== "apply",
                destructiveHint: operation === "apply",
                idempotentHint: true,
                openWorldHint: false,
              },
            },
            async (input: any) => {
              try {
                const id = await mergeDraft(input.draft);
                if (operation !== "plan") {
                  const stored = await get(input.plan, "merge-plan");
                  if (!stored || stored.data.draft !== id)
                    throw new Error("Merge plan outside draft scope");
                }
                return toolResult(
                  operation === "plan"
                    ? await merges.plan(mergeActor, id)
                    : operation === "file"
                      ? await merges.file(mergeActor, input.plan, input.path)
                      : {
                          ...(await merges.apply(mergeActor, input)),
                          next: "Validate content and submit_review; old approvals do not apply.",
                        },
                );
              } catch (error) {
                return toolError(error);
              }
            },
          );
        }
      }
      registerContentTools(server, {
        engine,
        read: !!grant && grant.read !== false,
        write: !!grant?.write,
        credentialId,
        actor: delegated?.actor ?? "agent",
        variant: (grant?.variant as Record<string, string>) ?? options.variant,
        saved: async (ref, revision, snapshot, paths) => {
          for (const path of paths) {
            const url = options.documentUrl?.(path);
            if (url)
              await reviews.recordEdit({
                ref,
                revision,
                snapshot,
                path,
                actor: delegated?.actor ?? "agent",
                page: {
                  url: pageLocation(url, options.origin),
                  version,
                  variant: (grant?.variant as Record<string, string>) ?? options.variant ?? {},
                },
              });
          }
        },
        authorize: async (draft, mutation) => {
          const active = await currentGrant();
          if (!active || (mutation ? !active.data.write : active.data.read === false))
            throw new Error("Credential expired, revoked, or missing permission");
          if (mutation && !draft && !grant?.draft)
            throw new Error("Create or select an authorized draft before editing");
          return authorizedRef(draft);
        },
        preview: async (draft, minutes) => {
          const active = await currentGrant();
          if (!active?.data.write || !delegated?.actor)
            throw new Error("Credential revoked or missing permission");
          if (!draft && !grant?.draft) throw new Error("Select an authorized draft first");
          const head = await engine.ref(await authorizedRef(draft));
          const token = secret(),
            expires = Date.now() + minutes * 60_000;
          const id = await put(
            "share",
            delegated.actor,
            {
              snapshot: head.snapshot,
              version,
              variant: (grant?.variant as Record<string, string>) ?? options.variant ?? {},
              created: Date.now(),
            },
            expires,
            digest(token),
          );
          return {
            id,
            snapshot: head.snapshot,
            expires: new Date(expires).toISOString(),
            url: `${options.origin}${base}/preview?token=${token}`,
          };
        },
      });
      if (grant?.write && delegated) {
        const actorId = delegated!.actor!;
        server.registerTool(
          "submit_review",
          {
            description:
              "Submit the delegated draft snapshot for human review. Does not approve or publish.",
            inputSchema: draftInput,
          },
          async ({ draft: selectedDraft }) => {
            const refName = await authorizedRef(selectedDraft);
            if (!bearer || !(await currentGrant()))
              throw new Error("Credential expired or revoked");
            const draft = await get(selectedDraft ?? String(grant.draft), "draft");
            if (!draft) throw new Error("Draft unavailable");
            const head = await cms.ref(refName);
            const result = await reviews.submit(
              { id: actorId, name: "Agent on behalf of draft owner", role: "editor" },
              {
                draft: draft.id,
                ref: refName,
                refRevision: head.revision,
                base: String(draft.data.base),
                baseRevision: Number(draft.data.baseRevision),
                snapshot: head.snapshot,
                version,
                variant: (grant.variant as Record<string, string>) ?? {},
              },
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ...result,
                    url: `${options.origin}${base}/review?id=${result.id}`,
                    next: "Human review required",
                  }),
                },
              ],
            };
          },
        );
      }
      if (grant?.write && delegated)
        server.registerTool(
          "get_review",
          {
            description:
              "Read review status and feedback for this delegated draft. Does not grant approval or publication.",
            inputSchema: { id: z.string(), ...draftInput },
          },
          async ({ id, draft }) => {
            const refName = await authorizedRef(draft);
            if (!bearer || !(await currentGrant()))
              throw new Error("Credential expired or revoked");
            const result = await reviews.get(
              { id: delegated!.actor!, name: "Draft agent", role: "editor" },
              id,
            );
            if (result.ref !== refName) throw new Error("Review outside delegated draft");
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    id: result.id,
                    revision: result.revision.id,
                    status: result.status,
                    requirements: result.requirements,
                    activity: result.activity,
                  }),
                },
              ],
            };
          },
        );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    };
    if (delegated && delegated.data.audience === `${options.origin}${base}/mcp`)
      return serve(delegated.data);
    if (options.identity?.guard)
      return options.identity.guard(async (req, jwt) => {
        if (typeof jwt.sub !== "string" || typeof jwt.client_id !== "string")
          return json({ error: "Invalid subject or client" }, 403);
        const user = await options.identity?.userById?.(jwt.sub);
        if (!user) return json({ error: "Account unavailable" }, 403);
        const person = await actorForUser(user);
        credentialId = `oauth:${digest(JSON.stringify([jwt.sub, jwt.client_id]))}`;
        const scopes = new Set(typeof jwt.scope === "string" ? jwt.scope.split(" ") : []);
        currentGrant = async () => {
          const stored = await get(credentialId, "oauth-agent");
          if (!stored || stored.actor !== person.id) return null;
          return {
            ...stored,
            data: {
              ...stored.data,
              read: scopes.has("content:read") && stored.data.read === true,
              write:
                person.role !== "reader" &&
                scopes.has("content:write") &&
                stored.data.write === true,
              createDrafts:
                person.role !== "reader" &&
                scopes.has("drafts:create") &&
                stored.data.createDrafts === true,
            },
          };
        };
        delegated = await currentGrant();
        if (!delegated)
          return json(
            { error: "Agent connection revoked or not approved. Reconnect with consent." },
            403,
          );
        return serve(delegated.data);
      })(request);
    return new Response(JSON.stringify({ error: "A draft-scoped agent credential is required" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": `Bearer resource_metadata="${options.origin}/.well-known/oauth-protected-resource${base}/mcp"`,
      },
    });
  }
  return {
    ready,
    view,
    actor,
    command,
    state,
    handler,
    asset: `${base}/assets/${assets["toolbar.js"].path}`,
  };
}
