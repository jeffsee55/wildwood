import { H3 } from "h3";
import { z } from "zod/v4";
import type { WildwoodClient } from "@/client/index";
import { gitObjectCacheHeaders } from "@/nextjs/vscode-embed-csp";
import type { WildwoodAuthAction } from "@/nextjs/auth";
import { isNativeRemoteNotImplementedError } from "./auth";
import { routeParamString } from "./util";

/* eslint-disable no-console */
const wildwoodGitApiLog = (...args: unknown[]) => {
  if (process.env.WILDWOOD_GIT_API_LOG === "0") return;
  console.info("[wildwood:git-api]", ...args);
};

/**
 * Route-injected authorizer. H3 handler owns no session — route layer
 * resolves user + calls `authorize`.
 */
export type GitServiceAuthorizeFn = (
  req: Request,
  action: WildwoodAuthAction,
) => Promise<Response | null>;

type GitServiceRouterOptions = {
  authorize?: GitServiceAuthorizeFn;
};

export function createGitServiceRouter(
  client: WildwoodClient,
  options: GitServiceRouterOptions = {},
): H3 {
  const git = client._.git;
  const remote = git.remote;
  const configRef = git.config.ref;
  const org = git.config.org;
  const repo = git.config.repo;
  const router = new H3();

  // ── branches ──────────────────────────────────────────────────────
  router.get("/branches", async () => {
    try {
      await client._.db.init();
      const worktreeRefs = await git.db.refs.listRefs();
      let remoteRefs: string[] = [];
      try {
        remoteRefs = await remote.listBranches();
      } catch (e) {
        console.error("Failed to list remote branches:", e);
      }
      const seen = new Set(worktreeRefs);
      const branches = [...worktreeRefs];
      for (const r of remoteRefs)
        if (!seen.has(r)) {
          seen.add(r);
          branches.push(r);
        }
      return Response.json({ branches });
    } catch (e) {
      console.error("Failed to list branches:", e);
      return new Response(
        `Failed to list branches: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  // ── editor guards / bootstrap ─────────────────────────────────────

  const checkEditorReady = async (refName: string) => {
    await client._.db.init();
    const resolved = await git.resolveWorktreeForApi({ ref: refName });
    const treeOid = resolved.rootTreeOid ?? resolved.commit.treeOid;
    const tree = await git.getTree(treeOid);
    const entryCount = tree ? Object.keys(tree).length : 0;
    if (entryCount === 0)
      throw new Error(
        `Repository tree for "${refName}" is not indexed yet. Redeploy after build prefetch completes.`,
      );
    return {
      ready: true as const,
      ref: refName,
      commitTreeOid: resolved.commit.treeOid,
      treeOid,
      entryCount,
    };
  };

  router.get("/editor-guards", async () => {
    try {
      const { resolveVscodeWebCdn } = await import("@/nextjs/vscode-web-cdn");
      const repoFull = `${org}/${repo}`;
      const { GitHubRemote: GR } = await import("@/git/remote/github");
      // Local dev uses NativeRemote — no GitHub App required. Only enforce
      // GitHub App checks when we're actually using the GitHub remote (production).
      if (!(remote instanceof GR)) {
        const cdn = await resolveVscodeWebCdn();
        return Response.json({
          status: "ready" as const,
          repo: repoFull,
          vscodeCommit: cdn.commit,
        });
      }
      const installation = await remote.getRepoInstallationStatus();
      const appSlug = process.env.GITHUB_APP_SLUG?.trim();
      if (installation.status === "not_installed") {
        return Response.json({
          status: "not_installed" as const,
          repo: repoFull,
          installUrl: appSlug ? `https://github.com/apps/${appSlug}/installations/new` : undefined,
          hint: `Install the GitHub App on ${repoFull}. Choose "Only select repositories" and pick ${repo}.`,
        });
      }
      if (installation.status === "not_configured") {
        return Response.json({
          status: "not_configured" as const,
          repo: repoFull,
          message:
            "GitHub App credentials are not configured on this deployment. Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_APP_SLUG in Vercel, then redeploy.",
        });
      }
      const cdn = await resolveVscodeWebCdn();
      return Response.json({ status: "ready" as const, repo: repoFull, vscodeCommit: cdn.commit });
    } catch (e) {
      console.error("Failed editor guards:", e);
      return Response.json(
        { status: "error", message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  });

  router.get("/editor-bootstrap", async (event) => {
    const {
      cookiesFromCookieHeader,
      resolveActiveRef,
      resolveBranch,
      WILDWOOD_BRANCH_COOKIE_FALLBACKS,
    } = await import("@/nextjs/resolve-active-ref");
    const { resolveVscodeWebCdn } = await import("@/nextjs/vscode-web-cdn");
    const cookies = cookiesFromCookieHeader(event.req.headers.get("cookie"));
    // new API is resolveBranch({ wildwood, cookies }), keep legacy compat
    let refName: string;
    try {
      refName = resolveBranch({ wildwood: client as never, cookies });
    } catch {
      refName = resolveActiveRef({ wildwood: client as never, cookies } as never);
    }
    // fallback to legacy shape if above failed due to old build
    if (!refName) {
      refName = resolveActiveRef({
        wildwood: client as never,
        cookies,
        cookieName: undefined,
      } as unknown as never);
      void WILDWOOD_BRANCH_COOKIE_FALLBACKS;
    }
    try {
      const payload = await checkEditorReady(refName);
      const cdn = await resolveVscodeWebCdn();
      return Response.json({ status: "ready", vscodeCommit: cdn.commit, ...payload });
    } catch (e) {
      console.error("Failed editor bootstrap:", e);
      return Response.json(
        { status: "error", message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  });

  // ── switch-branch / create-branch ─────────────────────────────────
  router.post("/switch-branch", async (event) => {
    try {
      const started = Date.now();
      const { ref: refParam } = z.object({ ref: z.string() }).parse(await event.req.json());
      const refName = refParam.trim();
      if (!refName) return new Response("ref is required", { status: 400 });
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.switchRef",
          ref: refName,
        });
        if (authError) return authError;
      }
      const exists = await git.db.refs.get({ ref: refName });
      if (!exists) return new Response(`Ref "${refName}" not found`, { status: 404 });
      console.info(`[wildwood:switch-branch] ref=${refName} ${Date.now() - started}ms`);
      return Response.json({ ok: true, ref: refName });
    } catch (e) {
      console.error("Failed to switch branch:", e);
      return new Response(
        `Failed to switch branch: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  router.post("/create-branch", async (event) => {
    try {
      const parsed = z
        .object({ name: z.string(), baseRef: z.string().optional(), base: z.string().optional() })
        .parse(await event.req.json());
      const base = (parsed.baseRef ?? parsed.base)?.trim();
      if (!base) return new Response("Missing base ref: send `baseRef` or `base`", { status: 400 });
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.createBranch",
          name: parsed.name,
          baseRef: base,
        });
        if (authError) return authError;
      }
      await git.createBranch({ name: parsed.name, base });
      return Response.json({ ok: true, ref: parsed.name });
    } catch (e) {
      console.error("Failed to create branch:", e);
      return new Response(
        `Failed to create branch: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  // ── worktrees / trees / blobs / commits / merge-base / pr ─────────
  const gitTreeEntrySchema = z.object({ type: z.enum(["blob", "tree"]), oid: z.string() });

  router.get("/worktrees/:ref", async (event) => {
    const refParam = routeParamString(event.context.params?.ref);
    if (!refParam) return new Response("Ref parameter required", { status: 400 });
    try {
      const refName = decodeURIComponent(refParam);
      wildwoodGitApiLog("GET /worktrees/:ref", {
        ref: refName,
        org,
        repo,
        url: event.url?.href ?? refParam,
      });
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.switchRef",
          ref: refName,
        });
        if (authError) return authError;
      }
      await client._.db.init();
      const resolved = await git.resolveWorktreeForApi({ ref: refName });
      wildwoodGitApiLog("GET /worktrees — ok (read)", {
        ref: refName,
        commitTree: resolved.commit.treeOid.slice(0, 7),
        hasRootTree: Boolean(resolved.rootTreeOid),
      });
      return Response.json(resolved);
    } catch (e) {
      console.error("Failed to fetch worktree:", e);
      return new Response(
        `Failed to fetch worktree: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  router.get("/tree/:oid", async (event) => {
    const oid = routeParamString(event.context.params?.oid);
    if (!oid) return new Response("OID parameter required", { status: 400 });
    try {
      wildwoodGitApiLog("GET /tree/:oid", { oid: oid.slice(0, 7), org, repo });
      const treeEntry = await git.getTree(oid);
      if (!treeEntry) {
        wildwoodGitApiLog("GET /tree/:oid — not found", { oid: oid.slice(0, 7) });
        return new Response("Tree not found", { status: 404 });
      }
      const entryCount = Object.keys(treeEntry).length;
      wildwoodGitApiLog("GET /tree/:oid — ok", { oid: oid.slice(0, 7), entryCount });
      if (entryCount === 0)
        console.warn("[wildwood:git-api] GET /tree/:oid — empty tree", {
          oid: oid.slice(0, 7),
          org,
          repo,
        });
      return Response.json(treeEntry, { headers: gitObjectCacheHeaders(oid) });
    } catch (e) {
      console.error("Failed to fetch tree:", e);
      return new Response(`Failed to fetch tree: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.get("/blob/:oid", async (event) => {
    await client._.db.init();
    const oid = routeParamString(event.context.params?.oid);
    if (!oid) return new Response("OID parameter required", { status: 400 });
    try {
      const localBlobs = await client._.git.db.blobs.batchGet({ oids: [oid] });
      if (localBlobs.length > 0) {
        return Response.json(
          { type: "blob", oid: localBlobs[0]!.oid, content: localBlobs[0]!.content },
          { headers: gitObjectCacheHeaders(oid) },
        );
      }
      const blobs = await remote.fetchBlobs({ oids: [oid] });
      if (blobs.length === 0) return new Response("Blob not found", { status: 404 });
      return Response.json(
        { type: "blob", oid: blobs[0]!.oid, content: blobs[0]!.content },
        { headers: gitObjectCacheHeaders(oid) },
      );
    } catch (e) {
      console.error("Failed to fetch blob:", e);
      return new Response(`Failed to fetch blob: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.get("/blob/:oid/raw", async (event) => {
    const oid = routeParamString(event.context.params?.oid);
    if (!oid) return new Response("OID parameter required", { status: 400 });
    try {
      const localBlobs = await client._.git.db.blobs.batchGet({ oids: [oid] });
      if (localBlobs.length > 0) {
        return new Response(new TextEncoder().encode(localBlobs[0]!.content), {
          headers: { "Content-Type": "application/octet-stream", ...gitObjectCacheHeaders(oid) },
        });
      }
      const raw = await remote.fetchBlobRaw({ oid });
      if (!raw) return new Response("Blob not found", { status: 404 });
      return new Response(new Uint8Array(raw), {
        headers: { "Content-Type": "application/octet-stream", ...gitObjectCacheHeaders(oid) },
      });
    } catch (e) {
      console.error("Failed to fetch raw blob:", e);
      return new Response(
        `Failed to fetch raw blob: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  router.get("/commit/:oid", async (event) => {
    const oid = routeParamString(event.context.params?.oid);
    if (!oid) return new Response("OID parameter required", { status: 400 });
    try {
      const commit = await git.getCommit(oid);
      if (!commit) return new Response("Commit not found", { status: 404 });
      return Response.json(commit);
    } catch (e) {
      console.error("Failed to fetch commit:", e);
      return new Response(`Failed to fetch commit: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.get("/merge-base/:ours/:theirs", async (event) => {
    const ours = routeParamString(event.context.params?.ours);
    const theirs = routeParamString(event.context.params?.theirs);
    if (!ours || !theirs)
      return new Response("Both ours and theirs params required", { status: 400 });
    try {
      const oursRef = decodeURIComponent(ours);
      const theirsRef = decodeURIComponent(theirs);
      const oursCommit = await remote.fetchCommit({ ref: oursRef });
      const theirsCommit = await remote.fetchCommit({ ref: theirsRef });
      if (oursCommit.oid === theirsCommit.oid)
        return Response.json({ oid: oursCommit.oid, treeOid: oursCommit.treeOid });
      const mergeBase = await git.trees.findMergeBase({
        oursOid: oursCommit.oid,
        theirsOid: theirsCommit.oid,
      });
      if (!mergeBase) return Response.json({ oid: null, treeOid: null });
      return Response.json({ oid: mergeBase.oid, treeOid: mergeBase.treeOid });
    } catch (e) {
      console.error("Failed to compute merge base:", e);
      return new Response(
        `Failed to compute merge base: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  // ── mutating: add / patch / commit / discard / push / pull / merge ─
  router.post("/add", async (event) => {
    try {
      const {
        ref: refParam,
        files: filesParam,
        stream: streamProgress,
      } = z
        .object({
          ref: z.string(),
          stream: z.boolean().optional(),
          files: z.record(z.string(), z.union([z.string(), z.object({ base64: z.string() })])),
        })
        .parse(await event.req.json());
      const files: Record<string, string | Uint8Array> = {};
      for (const [filePath, content] of Object.entries(filesParam)) {
        if (typeof content === "string") files[filePath] = content;
        else files[filePath] = Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0));
      }
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.add",
          ref: refParam,
          paths: Object.keys(files),
        });
        if (authError) return authError;
      }

      if (streamProgress) {
        const encoder = new TextEncoder();
        const bodyStream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const emit = (p: Record<string, unknown>) =>
              controller.enqueue(encoder.encode(`${JSON.stringify(p)}\n`));
            try {
              const addResult = await client._.git.add({
                ref: refParam,
                files,
                onProgress: (m) => emit({ type: "progress", message: m }),
              });
              emit({
                type: "done",
                ref: refParam,
                files: addResult.files,
                rootTreeOid: addResult.rootTreeOid,
              });
            } catch (error) {
              emit({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
            } finally {
              controller.close();
            }
          },
        });
        return new Response(bodyStream, {
          headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
        });
      }

      const addResult = await client._.git.add({ ref: refParam, files });
      return Response.json({
        ref: refParam,
        files: addResult.files,
        rootTreeOid: addResult.rootTreeOid,
      });
    } catch (e) {
      console.error("Failed to add files:", e);
      return new Response(`Failed to add files: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.post("/patch-worktree", async (event) => {
    try {
      const parsed = z
        .object({
          ref: z.string(),
          rootTreeOid: z.string(),
          changedFiles: z
            .array(z.object({ path: z.string(), oid: z.string(), content: z.string() }))
            .default([]),
          trees: z
            .array(z.object({ oid: z.string(), entries: z.record(z.string(), gitTreeEntrySchema) }))
            .default([]),
        })
        .parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.patchWorktree",
          ref: parsed.ref,
          paths: parsed.changedFiles.length > 0 ? parsed.changedFiles.map((f) => f.path) : ["."],
        });
        if (authError) return authError;
      }
      const result = await client._.git.patchWorktree({
        ref: parsed.ref,
        rootTreeOid: parsed.rootTreeOid,
        trees: parsed.trees,
        changedFiles: parsed.changedFiles,
      } as never);
      return Response.json(result);
    } catch (e) {
      console.error("Failed to patch worktree:", e);
      return new Response(
        `Failed to patch worktree: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });

  router.post("/commit", async (event) => {
    try {
      const {
        ref: refParam,
        message,
        author,
      } = z
        .object({
          ref: z.string(),
          message: z.string(),
          author: z.object({ name: z.string(), email: z.string() }),
        })
        .parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.commit",
          ref: refParam,
          message,
        });
        if (authError) return authError;
      }
      const commit = await git.commit({ ref: refParam, commit: { message, author } });
      return Response.json(commit);
    } catch (e) {
      console.error("Failed to commit:", e);
      return new Response(`Failed to commit: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.post("/discard", async (event) => {
    try {
      const { ref: refParam } = z.object({ ref: z.string() }).parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.discard",
          ref: refParam,
        });
        if (authError) return authError;
      }
      await git.discard({ ref: refParam });
      return Response.json({ ok: true });
    } catch (e) {
      console.error("Failed to discard:", e);
      return new Response(`Failed to discard: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.post("/push", async (event) => {
    try {
      const { ref: refParam } = z.object({ ref: z.string() }).parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.push",
          ref: refParam,
        });
        if (authError) return authError;
      }
      const result = await git.push({ ref: refParam });
      return Response.json({ ok: true, commitOid: result.commitOid });
    } catch (e) {
      console.error("Failed to push:", e);
      return new Response(`Failed to push: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.post("/pull", async (event) => {
    try {
      const { ref: refParam } = z.object({ ref: z.string() }).parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.pull",
          ref: refParam,
        });
        if (authError) return authError;
      }
      const pullResult = await git.pull({ ref: refParam });
      if ((pullResult as { type: string }).type === "conflict")
        return new Response("Pull resulted in merge conflicts", { status: 409 });
      const successResult = pullResult as { commit: { treeOid: string } };
      await git.db.refs.updateCommit({
        ref: refParam,
        commit: (pullResult as never as { commit: never }).commit,
      });
      await git.db.refs.setTreeOid({ ref: refParam, treeOid: successResult.commit.treeOid });
      return Response.json({
        ok: true,
        commitOid: (pullResult as { commit: { oid: string } }).commit.oid,
      });
    } catch (e) {
      console.error("Failed to pull:", e);
      return new Response(`Failed to pull: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.post("/merge", async (event) => {
    try {
      const { ref: refParam, message: messageParam } = z
        .object({ ref: z.string(), message: z.string().optional() })
        .parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.merge",
          ref: refParam,
          message: messageParam,
        });
        if (authError) return authError;
      }
      if (refParam === configRef) {
        return Response.json({
          ok: true,
          pr: null,
          commitOid: null,
          message: `Already on ${configRef}; nothing to merge.`,
        });
      }
      try {
        let pr = await remote.findPr({ head: refParam, base: configRef });
        if (!pr) {
          pr = await remote.createPr({
            head: refParam,
            base: configRef,
            title: `Merge ${refParam} into ${configRef}`,
            body: `Auto-created by Wildwood for ${refParam} -> ${configRef}.`,
          });
        }
        const comment = messageParam?.trim();
        if (comment) await remote.createPrComment({ pr: pr.number, body: comment });
        const mergeResult = await remote.mergePr({ pr: pr.number, method: "squash" });
        try {
          const pullResult = await git.pull({ ref: configRef });
          if ((pullResult as { type: string }).type === "success") {
            await git.db.refs.updateCommit({
              ref: configRef,
              commit: (pullResult as never as { commit: never }).commit,
            });
            await git.db.refs.setTreeOid({
              ref: configRef,
              treeOid: (pullResult as { commit: { treeOid: string } }).commit.treeOid,
            });
          }
        } catch (pullError) {
          console.error(
            `[gitService] PR merged successfully but local pull failed for ${configRef}:`,
            pullError,
          );
        }
        return Response.json({
          ok: true,
          pr: { number: pr.number, url: pr.url },
          commitOid: mergeResult.commitOid,
        });
      } catch (error) {
        if (!isNativeRemoteNotImplementedError(error)) throw error;
        console.warn(
          `[gitService] PR operations are not implemented for NativeRemote; falling back to local merge (${refParam} -> ${configRef})`,
          error,
        );
        const localMerge = await git.merge({
          ours: configRef,
          theirs: refParam,
          message: messageParam,
        } as never);
        if ((localMerge as { type: string }).type === "conflict") {
          return new Response(
            `Failed to merge: local merge conflict for ${refParam} -> ${configRef}`,
            { status: 409 },
          );
        }
        await git.db.refs.updateCommit({
          ref: configRef,
          commit: (localMerge as never as { commit: never }).commit,
        });
        await git.db.refs.setTreeOid({
          ref: configRef,
          treeOid: (localMerge as { commit: { treeOid: string } }).commit.treeOid,
        });
        return Response.json({
          ok: true,
          pr: null,
          commitOid: (localMerge as { commit: { oid: string } }).commit.oid,
        });
      }
    } catch (e) {
      console.error("Failed to merge:", e);
      return new Response(`Failed to merge: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.post("/create-pr", async (event) => {
    try {
      const {
        ref: refParam,
        title: titleParam,
        body: bodyParam,
      } = z
        .object({ ref: z.string(), title: z.string().optional(), body: z.string().optional() })
        .parse(await event.req.json());
      if (options.authorize) {
        const authError = await options.authorize(event.req as unknown as Request, {
          type: "git.createPr",
          ref: refParam,
          title: titleParam,
          body: bodyParam,
        });
        if (authError) return authError;
      }
      let pr = await remote.findPr({ head: refParam, base: configRef });
      if (!pr) {
        const defaultTitle = `Merge ${refParam} into ${configRef}`;
        const defaultBody = `Auto-created by Wildwood for ${refParam} -> ${configRef}.`;
        const rawTitle = titleParam?.trim() || defaultTitle;
        const MAX_TITLE = 128;
        const title = rawTitle.length > MAX_TITLE ? `${rawTitle.slice(0, MAX_TITLE)}…` : rawTitle;
        pr = await remote.createPr({
          head: refParam,
          base: configRef,
          title,
          body: bodyParam?.trim() || defaultBody,
        });
      }
      return Response.json({ ok: true, pr: { number: pr.number, url: pr.url } });
    } catch (e) {
      console.error("Failed to create PR:", e);
      return new Response(`Failed to create PR: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  router.get("/pr/:ref", async (event) => {
    try {
      const refParam = routeParamString(event.context.params?.ref);
      if (!refParam) return new Response("Ref parameter required", { status: 400 });
      const headRef = decodeURIComponent(refParam);
      const pr = await remote.findPr({ head: headRef, base: configRef });
      if (!pr) return Response.json({ pr: null });
      return Response.json({ pr: { number: pr.number, url: pr.url } });
    } catch (e) {
      console.error("Failed to find PR:", e);
      return new Response(`Failed to find PR: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  });

  return router;
}
