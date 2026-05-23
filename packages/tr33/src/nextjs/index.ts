// import extension from "tr33-vscode";

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateBlobOid, calculateBlobOidFromBytes } from "tr33-store";
import extensionPkg from "tr33-vscode/package.json" with { type: "json" };
import { H3, html, serveStatic, setResponseHeader } from "h3";
import { z } from "zod/v4";
import {
  type Tr33AuthAction,
  userFromUnknownSession,
} from "@/client/auth";
import type { Tr33Client } from "@/client/index";
import { getCode } from "@/nextjs/code";
import {
  stripBuiltInCspMetaFromHtml,
  VSCODE_EMBED_DOCUMENT_CSP,
  VSCODE_EMBED_HTML_RESPONSE_HEADERS,
  vscodeEmbedCorsHeaders,
  vscodeWebStaticCacheHeaders,
  withVscodeEmbedCors,
} from "@/nextjs/vscode-embed-csp";
import {
  TR33_ACTIVE_REF_COOKIE,
  TR33_SYNC_HOST_ACTIVE_REF_HEADER,
  activeRefSetCookieHeader,
} from "@/nextjs/preview-cookies";
import {
  cookiesFromCookieHeader,
  resolveActiveRef,
} from "@/nextjs/resolve-active-ref";
import { resolveVscodeWebCdn } from "@/nextjs/vscode-web-cdn";

/** Turbopack/Next do not implement `import.meta.resolve`; use CJS resolver instead. */
const nodeRequire = createRequire(import.meta.url);

/**
 * Path to `tr33-vscode/package.json`. Next/Turbopack bundles `createHandler` such that
 * `createRequire(import.meta.url).resolve("tr33-vscode/package.json")` can return pnpm
 * `[project]/packages/extension/...` placeholders that are not real filesystem paths.
 * Fall back to cwd-relative and monorepo layouts used by `apps/*`.
 */
function resolveTr33VscodePackageJsonPath(): string {
  const tryRequireFromTr33Pkg = (): string | undefined => {
    try {
      const tr33PkgJson = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "package.json",
      );
      if (!existsSync(tr33PkgJson)) return undefined;
      const req = createRequire(tr33PkgJson);
      const resolved = req.resolve("tr33-vscode/package.json");
      if (!resolved.includes("[project]") && existsSync(resolved))
        return resolved;
    } catch {
      /* ignore */
    }
    return undefined;
  };

  const fromTr33 = tryRequireFromTr33Pkg();
  if (fromTr33) return fromTr33;

  try {
    const resolved = nodeRequire.resolve("tr33-vscode/package.json");
    if (!resolved.includes("[project]") && existsSync(resolved))
      return resolved;
  } catch {
    /* ignore */
  }

  const cwd = process.cwd();
  const fallbacks = [
    path.join(cwd, "node_modules", "tr33-vscode", "package.json"),
    path.join(
      cwd,
      "node_modules",
      "tr33",
      "node_modules",
      "tr33-vscode",
      "package.json",
    ),
    path.join(cwd, "..", "..", "packages", "extension", "package.json"),
    path.join(cwd, "packages", "extension", "package.json"),
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    `Could not resolve tr33-vscode package.json (cwd=${cwd}). Install workspace deps or run from the monorepo.`,
  );
}

const extensionPkgSchema = z.object({
  name: z.string(),
  publisher: z.string(),
  version: z.string(),
  enabledApiProposals: z.array(z.string()),
});

const setNoStoreHeaders = (event: {
  node?: { res?: { setHeader: (k: string, v: string) => void } };
}) => {
  event.node?.res?.setHeader(
    "cache-control",
    "no-store, no-cache, must-revalidate",
  );
  event.node?.res?.setHeader("pragma", "no-cache");
  event.node?.res?.setHeader("expires", "0");
};

export const createHandler = (
  client: Tr33Client,
  options?: { currentRef?: string },
) => {
  const base = new H3();
  const app = new H3();
  const vscode = new H3();
  const gitService = new H3();
  const git = client._.git;
  const org = git.config.org;
  const repo = git.config.repo;
  const repoFull = `${org}/${repo}`;
  const ref = git.config.ref;
  const serverCurrentRef = options?.currentRef;
  const remote = git.remote;
  const pkg = extensionPkgSchema.parse(extensionPkg);

  const resolveAuthUser = async (request: Request) => {
    if (client._.auth?.getUser) {
      return client._.auth.getUser(request);
    }
    if (client._.auth?.betterAuth) {
      const session = await client._.auth.betterAuth.api.getSession({
        headers: request.headers,
      });
      return userFromUnknownSession(session);
    }
    return null;
  };

  const authorizeGitAction = async (
    request: Request,
    action: Tr33AuthAction,
  ): Promise<Response | null> => {
    const authorize = client._.auth?.authorize;
    if (!authorize) {
      return null;
    }
    const user = await resolveAuthUser(request);
    const result = await authorize({
      action,
      config: client._.config,
      request,
      user,
    });
    if (result instanceof Response) {
      return result;
    }
    if (result === false) {
      return new Response("Forbidden", { status: 403 });
    }
    return null;
  };

  const isNativeRemoteNotImplementedError = (error: unknown): boolean => {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes("not implemented for nativeremote")
    );
  };

  const getWorkbenchConfig = async (event: {
    url: URL;
    req: { headers: { get: (name: string) => string | null } };
  }) => {
    const dir = event.url.pathname.split("/").slice(0, -1).join("/");
    const cdn = await resolveVscodeWebCdn();
    const webEndpointBase = `${event.url.origin}${dir}/cdn/${cdn.commit}`;
    const comparisonRef = ref;
    const cookies = cookiesFromCookieHeader(event.req.headers.get("cookie"));
    const explicitActiveRefCookie = cookies
      .get(TR33_ACTIVE_REF_COOKIE)
      ?.value?.trim();
    const refFromCookie = resolveActiveRef({
      tr33: client,
      cookies,
    });
    const queryRef = event.url.searchParams.get("ref")?.trim();
    /*
     * Prefer `tr33-active-ref` over `?ref=` when the cookie is set. The Kit iframe always
     * adds `?ref=` from server props; after a branch switch the cookie updates immediately
     * while RSC may still serve stale `activeRef`, so query would otherwise win and open
     * the editor on the wrong worktree.
     */
    const currentRef =
      serverCurrentRef ??
      (explicitActiveRefCookie
        ? explicitActiveRefCookie
        : queryRef
          ? queryRef
          : refFromCookie);
    /*
     * Builtin extension URL must be path-only: no `?query` here. VS Code joins
     * `.../extension` + `/package.json`; a `?` in the path becomes `%3F` and requests
     * `/extension%3Frepo=.../package.json` (404). Repo/ref come from configurationDefaults
     * and the workspace folder URI instead.
     *
     * Do not put a query on `folderUri` either: the workbench may encode the whole query
     * string once, so `&` becomes `%26` and `URLSearchParams` no longer splits params —
     * the extension FS then mis-parses repo/ref. Path is `/owner/repo`; refs live in
     * `configurationDefaults` (`tr33.*`) and are read by Tr33FileSystemProvider.
     */
    const builtinExtensions: {
      scheme: string;
      authority: string;
      path: string;
    }[] = [
      {
        scheme: event.url.protocol.replace(":", ""),
        authority: event.url.host,
        path: `${dir}/extension`,
      },
    ];
    return {
      productConfiguration: {
        nameShort: "VSCode Web Sample",
        nameLong: "VSCode Web sample",
        applicationName: "code-web-sample",
        dataFolderName: ".vscode-web-sample",
        version: cdn.version,
        commit: cdn.commit,
        webEndpointUrl: webEndpointBase,
        webEndpointUrlTemplate: webEndpointBase,
        extensionsGallery: {
          serviceUrl: "https://open-vsx.org/vscode/gallery",
          itemUrl: "https://open-vsx.org/vscode/item",
          resourceUrlTemplate:
            "https://openvsxorg.blob.core.windows.net/resources/{publisher}/{name}/{version}/{path}",
        },
        extensionEnabledApiProposals: {
          [`${pkg.publisher}.${pkg.name}`]: pkg.enabledApiProposals,
          nullExtensionDescription: pkg.enabledApiProposals,
        },
      },
      folderUri: {
        scheme: "vscode-vfs",
        authority: event.url.host,
        path: `/${repoFull}`,
      },
      additionalBuiltinExtensions: builtinExtensions,
      configurationDefaults: {
        "workbench.colorTheme": "Tr33 Dark",
        "tr33.repo": repoFull,
        "tr33.headRef": currentRef,
        "tr33.baseRef": comparisonRef,
        "workbench.editorAssociations": {
          "*.png": "tr33.imagePreview",
          "*.jpg": "tr33.imagePreview",
          "*.jpeg": "tr33.imagePreview",
          "*.gif": "tr33.imagePreview",
          "*.webp": "tr33.imagePreview",
          "*.svg": "tr33.imagePreview",
          "*.bmp": "tr33.imagePreview",
          "*.ico": "tr33.imagePreview",
        },
      },
    };
  };

  gitService.get("/branches", async () => {
    try {
      await client._.db.init();
      const worktreeRefs = await git.db.refs.listRefs();
      let remoteRefs: string[] = [];
      try {
        remoteRefs = await remote.listBranches();
      } catch (err) {
        console.error("Failed to list remote branches:", err);
      }
      const seen = new Set(worktreeRefs);
      const branches = [...worktreeRefs];
      for (const r of remoteRefs) {
        if (!seen.has(r)) {
          seen.add(r);
          branches.push(r);
        }
      }
      return Response.json({ branches });
    } catch (error) {
      console.error("Failed to list branches:", error);
      return new Response(
        `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/worktrees/:ref", async (event) => {
    const refParam = event.context.params?.ref;
    if (!refParam) {
      return new Response("Ref parameter required", { status: 400 });
    }

    try {
      const refName = decodeURIComponent(refParam);
      tr33GitApiLog("GET /worktrees/:ref", {
        ref: refName,
        org,
        repo,
        url: event.url?.href ?? refParam,
      });
      const authError = await authorizeGitAction(event.req, {
        type: "git.switchRef",
        ref: refName,
      });
      if (authError) return authError;
      await client._.git.switch({ ref: refName });
      const worktree = await git.db.refs.get({ ref: refName });
      if (!worktree) {
        await client._.db.init();
        const commit = await remote.fetchCommit({ ref: refName });
        tr33GitApiLog("GET /worktrees — no local worktree row, using remote commit", {
          ref: refName,
          treeOid: commit.treeOid.slice(0, 7),
        });
        return Response.json({
          commit: { oid: commit.oid, treeOid: commit.treeOid },
          rootTreeOid: null,
        });
      }
      tr33GitApiLog("GET /worktrees — ok", {
        ref: refName,
        commitTree: worktree.commit.treeOid.slice(0, 7),
        hasRootTree: Boolean(worktree.rootTree?.oid),
      });
      return Response.json({
        commit: { oid: worktree.commit.oid, treeOid: worktree.commit.treeOid },
        rootTreeOid:
          worktree.rootTree?.oid &&
          worktree.rootTree.oid !== worktree.commit.treeOid
            ? worktree.rootTree.oid
            : null,
      });
    } catch (error) {
      console.error("Failed to fetch worktree:", error);
      return new Response(
        `Failed to fetch worktree: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/tree/:oid", async (event) => {
    const oid = event.context.params?.oid;
    if (!oid) {
      return new Response("OID parameter required", { status: 400 });
    }

    try {
      tr33GitApiLog("GET /tree/:oid", {
        oid: oid.slice(0, 7),
        org,
        repo,
      });
      const treeEntry = await git.getTree(oid);
      if (!treeEntry) {
        tr33GitApiLog("GET /tree/:oid — not found (db + remote)", {
          oid: oid.slice(0, 7),
        });
        return new Response("Tree not found", { status: 404 });
      }
      const entryCount = Object.keys(treeEntry).length;
      tr33GitApiLog("GET /tree/:oid — ok", {
        oid: oid.slice(0, 7),
        entryCount,
      });
      return Response.json(treeEntry);
    } catch (error) {
      console.error("Failed to fetch tree:", error);
      return new Response(
        `Failed to fetch tree: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/blob/:oid", async (event) => {
    // middleware not working
    await client._.db.init();
    const oid = event.context.params?.oid;
    if (!oid) {
      return new Response("OID parameter required", { status: 400 });
    }

    try {
      // First, try to get from local database
      const localBlobs = await client._.git.db.blobs.batchGet({ oids: [oid] });
      if (localBlobs.length > 0) {
        return Response.json({
          type: "blob",
          oid: localBlobs[0].oid,
          content: localBlobs[0].content,
        });
      }

      // If not found locally, fetch from remote
      const blobs = await remote.fetchBlobs({ oids: [oid] });
      if (blobs.length === 0) {
        return new Response("Blob not found", { status: 404 });
      }

      return Response.json({
        type: "blob",
        oid: blobs[0].oid,
        content: blobs[0].content,
      });
    } catch (error) {
      console.error("Failed to fetch blob:", error);
      return new Response(
        `Failed to fetch blob: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/blob/:oid/raw", async (event) => {
    const oid = event.context.params?.oid;
    if (!oid) {
      return new Response("OID parameter required", { status: 400 });
    }

    try {
      // Check local DB first (text blobs stored as strings)
      const localBlobs = await client._.git.db.blobs.batchGet({ oids: [oid] });
      if (localBlobs.length > 0) {
        return new Response(new TextEncoder().encode(localBlobs[0].content), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      // Fetch raw bytes from remote
      const raw = await remote.fetchBlobRaw({ oid });
      if (!raw) {
        return new Response("Blob not found", { status: 404 });
      }
      return new Response(new Uint8Array(raw), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (error) {
      console.error("Failed to fetch raw blob:", error);
      return new Response(
        `Failed to fetch raw blob: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/commit/:oid", async (event) => {
    const oid = event.context.params?.oid;
    if (!oid) {
      return new Response("OID parameter required", { status: 400 });
    }

    try {
      const commit = await git.getCommit(oid);
      if (!commit) {
        return new Response("Commit not found", { status: 404 });
      }
      return Response.json(commit);
    } catch (error) {
      console.error("Failed to fetch commit:", error);
      return new Response(
        `Failed to fetch commit: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/merge-base/:ours/:theirs", async (event) => {
    const ours = event.context.params?.ours;
    const theirs = event.context.params?.theirs;
    if (!ours || !theirs) {
      return new Response("Both ours and theirs params required", {
        status: 400,
      });
    }
    try {
      const oursRef = decodeURIComponent(ours);
      const theirsRef = decodeURIComponent(theirs);
      const oursCommit = await remote.fetchCommit({ ref: oursRef });
      const theirsCommit = await remote.fetchCommit({ ref: theirsRef });
      if (oursCommit.oid === theirsCommit.oid) {
        return Response.json({
          oid: oursCommit.oid,
          treeOid: oursCommit.treeOid,
        });
      }
      const mergeBase = await git.trees.findMergeBase({
        oursOid: oursCommit.oid,
        theirsOid: theirsCommit.oid,
      });
      if (!mergeBase) {
        return Response.json({ oid: null, treeOid: null });
      }
      return Response.json({ oid: mergeBase.oid, treeOid: mergeBase.treeOid });
    } catch (error) {
      console.error("Failed to compute merge base:", error);
      return new Response(
        `Failed to compute merge base: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/create-branch", async (event) => {
    try {
      const body = await event.req.json();
      const parsed = z
        .object({
          name: z.string(),
          /** Preferred; explicit “new branch from {ref}”. */
          baseRef: z.string().optional(),
          base: z.string().optional(),
        })
        .parse(body);
      const base = (parsed.baseRef ?? parsed.base)?.trim();
      if (!base) {
        return new Response("Missing base ref: send `baseRef` or `base`", {
          status: 400,
        });
      }
      const { name } = parsed;
      const authError = await authorizeGitAction(event.req, {
        type: "git.createBranch",
        name,
        baseRef: base,
      });
      if (authError) return authError;

      await git.createBranch({ name, base });

      return Response.json({ ok: true, ref: name });
    } catch (error) {
      console.error("Failed to create branch:", error);
      return new Response(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/add", async (event) => {
    try {
      const body = await event.req.json();
      const { ref: refParam, files: filesParam } = z
        .object({
          ref: z.string(),
          files: z.record(
            z.string(),
            z.union([z.string(), z.object({ base64: z.string() })]),
          ),
        })
        .parse(body);

      const files: Record<string, string | Uint8Array> = {};
      for (const [path, content] of Object.entries(filesParam)) {
        if (typeof content === "string") {
          files[path] = content;
        } else {
          const bytes = Uint8Array.from(atob(content.base64), (c) =>
            c.charCodeAt(0),
          );
          files[path] = bytes;
        }
      }
      const authError = await authorizeGitAction(event.req, {
        type: "git.add",
        ref: refParam,
        paths: Object.keys(files),
      });
      if (authError) return authError;

      await client._.git.add({
        ref: refParam,
        files,
      });

      const filesWithOids: Record<string, string> = {};
      for (const [path, content] of Object.entries(files)) {
        const oid =
          content instanceof Uint8Array
            ? await calculateBlobOidFromBytes(content)
            : await calculateBlobOid(content);
        filesWithOids[path] = oid;
      }

      return Response.json({
        ref: refParam,
        files: filesWithOids,
      });
    } catch (error) {
      console.error("Failed to add files:", error);
      return new Response(
        `Failed to add files: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/commit", async (event) => {
    try {
      const body = await event.req.json();
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
        .parse(body);
      const authError = await authorizeGitAction(event.req, {
        type: "git.commit",
        ref: refParam,
        message,
      });
      if (authError) return authError;

      const commit = await git.commit({
        ref: refParam,
        commit: { message, author },
      });

      return Response.json(commit);
    } catch (error) {
      console.error("Failed to commit:", error);
      return new Response(
        `Failed to commit: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/discard", async (event) => {
    try {
      const body = await event.req.json();
      const { ref: refParam } = z.object({ ref: z.string() }).parse(body);
      const authError = await authorizeGitAction(event.req, {
        type: "git.discard",
        ref: refParam,
      });
      if (authError) return authError;

      await git.discard({ ref: refParam });

      return Response.json({ ok: true });
    } catch (error) {
      console.error("Failed to discard:", error);
      return new Response(
        `Failed to discard: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/push", async (event) => {
    try {
      const body = await event.req.json();
      const { ref: refParam } = z.object({ ref: z.string() }).parse(body);
      const authError = await authorizeGitAction(event.req, {
        type: "git.push",
        ref: refParam,
      });
      if (authError) return authError;

      const result = await git.push({ ref: refParam });

      return Response.json({
        ok: true,
        commitOid: result.commitOid,
      });
    } catch (error) {
      console.error("Failed to push:", error);
      return new Response(
        `Failed to push: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/pull", async (event) => {
    try {
      const body = await event.req.json();
      const { ref: refParam } = z.object({ ref: z.string() }).parse(body);
      const authError = await authorizeGitAction(event.req, {
        type: "git.pull",
        ref: refParam,
      });
      if (authError) return authError;

      const pullResult = await git.pull({ ref: refParam });
      if (pullResult.type === "conflict") {
        return new Response("Pull resulted in merge conflicts", {
          status: 409,
        });
      }

      await git.db.refs.updateCommit({
        ref: refParam,
        commit: pullResult.commit,
      });
      await git.db.refs.setTreeOid({
        ref: refParam,
        treeOid: pullResult.commit.treeOid,
      });

      return Response.json({
        ok: true,
        commitOid: pullResult.commit.oid,
      });
    } catch (error) {
      console.error("Failed to pull:", error);
      return new Response(
        `Failed to pull: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/merge", async (event) => {
    try {
      const body = await event.req.json();
      const { ref: refParam, message: messageParam } = z
        .object({
          ref: z.string(),
          message: z.string().optional(),
        })
        .parse(body);
      const authError = await authorizeGitAction(event.req, {
        type: "git.merge",
        ref: refParam,
        message: messageParam,
      });
      if (authError) return authError;

      // Merge target is config ref (comparison base).
      if (refParam === ref) {
        return Response.json({
          ok: true,
          pr: null,
          commitOid: null,
          message: `Already on ${ref}; nothing to merge.`,
        });
      }

      try {
        let pr = await remote.findPr({
          head: refParam,
          base: ref,
        });
        if (!pr) {
          pr = await remote.createPr({
            head: refParam,
            base: ref,
            title: `Merge ${refParam} into ${ref}`,
            body: `Auto-created by Tr33 for ${refParam} -> ${ref}.`,
          });
        }

        const comment = messageParam?.trim();
        if (comment) {
          await remote.createPrComment({ pr: pr.number, body: comment });
        }

        const mergeResult = await remote.mergePr({
          pr: pr.number,
          method: "squash",
        });

        try {
          const pullResult = await git.pull({ ref });
          if (pullResult.type === "success") {
            await git.db.refs.updateCommit({
              ref,
              commit: pullResult.commit,
            });
            await git.db.refs.setTreeOid({
              ref,
              treeOid: pullResult.commit.treeOid,
            });
          }
        } catch (pullError) {
          console.error(
            `[gitService] PR merged successfully but local pull failed for ${ref}:`,
            pullError,
          );
        }

        return Response.json({
          ok: true,
          pr: {
            number: pr.number,
            url: pr.url,
          },
          commitOid: mergeResult.commitOid,
        });
      } catch (error) {
        if (!isNativeRemoteNotImplementedError(error)) {
          throw error;
        }

        console.warn(
          `[gitService] PR operations are not implemented for NativeRemote; falling back to local merge (${refParam} -> ${ref})`,
          error,
        );

        const localMerge = await git.merge({
          ours: ref,
          theirs: refParam,
          message: messageParam,
        });
        if (localMerge.type === "conflict") {
          return new Response(
            `Failed to merge: local merge conflict for ${refParam} -> ${ref}`,
            { status: 409 },
          );
        }

        await git.db.refs.updateCommit({
          ref,
          commit: localMerge.commit,
        });
        await git.db.refs.setTreeOid({
          ref,
          treeOid: localMerge.commit.treeOid,
        });

        return Response.json({
          ok: true,
          pr: null,
          commitOid: localMerge.commit.oid,
        });
      }
    } catch (error) {
      console.error("Failed to merge:", error);
      return new Response(
        `Failed to merge: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.post("/create-pr", async (event) => {
    try {
      const body = await event.req.json();
      const {
        ref: refParam,
        title: titleParam,
        body: bodyParam,
      } = z
        .object({
          ref: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
        })
        .parse(body);
      const authError = await authorizeGitAction(event.req, {
        type: "git.createPr",
        ref: refParam,
        title: titleParam,
        body: bodyParam,
      });
      if (authError) return authError;

      let pr = await remote.findPr({
        head: refParam,
        base: ref,
      });
      if (!pr) {
        const defaultTitle = `Merge ${refParam} into ${ref}`;
        const defaultBody = `Auto-created by Tr33 for ${refParam} -> ${ref}.`;
        const rawTitle = titleParam?.trim() || defaultTitle;
        const MAX_TITLE_LENGTH = 128;
        const title =
          rawTitle.length > MAX_TITLE_LENGTH
            ? `${rawTitle.slice(0, MAX_TITLE_LENGTH)}…`
            : rawTitle;
        pr = await remote.createPr({
          head: refParam,
          base: ref,
          title,
          body: bodyParam?.trim() || defaultBody,
        });
      }

      return Response.json({
        ok: true,
        pr: {
          number: pr.number,
          url: pr.url,
        },
      });
    } catch (error) {
      console.error("Failed to create PR:", error);
      return new Response(
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  gitService.get("/pr/:ref", async (event) => {
    try {
      const refParam = event.context.params?.ref;
      if (!refParam) {
        return new Response("Ref parameter required", { status: 400 });
      }
      const headRef = decodeURIComponent(refParam);
      const pr = await remote.findPr({
        head: headRef,
        base: ref,
      });
      if (!pr) {
        return Response.json({ pr: null });
      }
      return Response.json({
        pr: {
          number: pr.number,
          url: pr.url,
        },
      });
    } catch (error) {
      console.error("Failed to find PR:", error);
      return new Response(
        `Failed to find PR: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  });

  // CORS for extension host on `*.vscode-cdn.net` loading `/api/vscode/extension/**`.
  vscode.use(async (event, next) => {
    const corsHeaders = vscodeEmbedCorsHeaders(event.req);
    if (event.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const response = await next();
    if (response instanceof Response) {
      return withVscodeEmbedCors(event.req, response);
    }
    return response;
  });

  vscode
    .get("/editor", async (event) => {
      setNoStoreHeaders(event);
      setResponseHeader(event, "Content-Security-Policy", VSCODE_EMBED_DOCUMENT_CSP);
      const workbenchConfig = await getWorkbenchConfig(event);
      const vscodeWebCdn = await resolveVscodeWebCdn();
      const code = getCode({
        origin: event.url.origin,
        prefix: "/api/vscode",
        workbenchConfig,
        vscodeWebCdn,
      });
      return html(event, code);
    })
    .get("/product.json", async (event) => {
      setNoStoreHeaders(event);
      return Response.json(await getWorkbenchConfig(event));
    })
    .get("extension/**:asset", async (event) => {
      setNoStoreHeaders(event);
      const asset = event.context.params?.asset;
      if (!asset) {
        return new Response(`No asset provided in query`, { status: 404 });
      }
      // Resolve the tr33-vscode package directory (see resolveTr33VscodePackageJsonPath)
      const extensionPkgPath = resolveTr33VscodePackageJsonPath();
      const extensionDir = path.dirname(extensionPkgPath);
      const filePath = path.join(extensionDir, asset);
      const served = await serveStatic(event, {
        getContents: async () => {
          const contents = await readFile(filePath);
          return new Uint8Array(contents);
        },
        getMeta: async () => {
          const fileStat = await stat(filePath);
          return {
            size: fileStat.size,
            mtime: fileStat.mtimeMs,
          };
        },
      });
      if (served instanceof Response) {
        return withVscodeEmbedCors(event.req, served);
      }
      return new Response("Not found", {
        status: 404,
        headers: vscodeEmbedCorsHeaders(event.req),
      });
    });

  // Same-origin proxy to main.vscode-cdn.net (module scripts need CORS; HTML needs CSP strip).
  const vscodeCdn = new H3();
  vscodeCdn.get("/:commit/**:asset", async (event) => {
    const asset = event.context.params?.asset;
    const commitParam = event.context.params?.commit;
    if (!asset || !commitParam) {
      return new Response("No asset path", { status: 404 });
    }
    const cdn = await resolveVscodeWebCdn();
    if (commitParam !== cdn.commit) {
      return new Response("VS Code commit mismatch", { status: 404 });
    }

    const cdnUrl = `${cdn.cdnBase}/${asset.replace(/^\/+/, "")}`;
    const range = event.req.headers.get("range");
    const upstream = await fetch(cdnUrl, {
      method: event.req.method === "HEAD" ? "HEAD" : "GET",
      headers: {
        "Accept-Encoding": "identity",
        ...(range ? { Range: range } : {}),
      },
    });
    if (!upstream.ok) {
      return new Response("Not found", { status: upstream.status });
    }

    const lower = asset.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      if (event.req.method === "HEAD") {
        return new Response(null, {
          status: upstream.status,
          headers: VSCODE_EMBED_HTML_RESPONSE_HEADERS,
        });
      }
      let contents = await upstream.text();
      contents = stripBuiltInCspMetaFromHtml(contents);
      return new Response(contents, {
        headers: VSCODE_EMBED_HTML_RESPONSE_HEADERS,
      });
    }

    const headers = new Headers();
    // `fetch` decompresses the body; forwarding `content-encoding` breaks the browser.
    const passthrough = [
      "content-type",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ] as const;
    for (const name of passthrough) {
      const value = upstream.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
    for (const [key, value] of Object.entries(
      vscodeWebStaticCacheHeaders(cdn.commit),
    )) {
      headers.set(key, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  });

  vscodeCdn.get("/", async (event) => {
    setNoStoreHeaders(event);
    const cdn = await resolveVscodeWebCdn();
    const base = event.url.pathname.replace(/\/$/, "");
    return Response.redirect(
      `${base}/${cdn.commit}/out/vs/code/browser/workbench/workbench.html`,
      302,
    );
  });

  vscode.mount("/cdn", vscodeCdn);
  app.mount("/git", gitService);
  app.mount("/vscode", vscode);

  base.use(async (event, next) => {
    const pathname = event.url.pathname;
    const isVscodeApi = pathname.startsWith("/api/vscode/");
    const corsHeaders = isVscodeApi
      ? vscodeEmbedCorsHeaders(event.req)
      : {
          "Access-Control-Allow-Origin":
            event.req.headers.get("origin") ?? "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Private-Network": "true",
        };
    if (event.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const res = await next();
    if (res instanceof Response && isVscodeApi) {
      return withVscodeEmbedCors(event.req, res);
    }
    if (res instanceof Response) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: h,
      });
    }
    return res;
  });
  base.mount("/api", app);
  return base;
};

export type HandleOptions = {
  /**
   * `revalidateTag` for Cache Components / `"use cache"` regions that depend on Tr33 git state.
   * Applied on: preview exit, **`tr33-active-ref`** updates, and successful **`POST …/git/(add|commit|discard|merge|pull)`**
   * so RSC sees updated worktree/DB.
   */
  revalidateTagOnDraftExit?: string;
};

/** Options for {@link handle}: Next middleware plus {@link createHandler}’s `currentRef`. */
export type Tr33NextHandlerOptions = HandleOptions & {
  /** Overrides config ref for the embedded VS Code workbench (see {@link createHandler}). */
  currentRef?: string;
};

/**
 * Preview exit, `tr33-active-ref` cookie on branch-changing routes — applied after H3 `fetch`.
 *
 * - **`POST …/tr33/preview`** — clears **`tr33-active-ref`**
 * - **`POST …/git/create-branch`** / **`GET …/git/worktrees/:ref`** (+ sync header) — sets cookie
 */
const tr33NextLog = (...args: unknown[]) => {
  console.info("[tr33:next]", ...args);
};

/** Git REST (`/api/git/*`) — set `TR33_GIT_API_LOG=0` to silence. */
const tr33GitApiLog = (...args: unknown[]) => {
  if (process.env.TR33_GIT_API_LOG === "0") {
    return;
  }
  console.info("[tr33:git-api]", ...args);
};

async function withNextTr33Response(
  request: Request,
  upstream: () => Response | Promise<Response>,
  options?: HandleOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  let createBranchNameFromRequest: string | undefined;
  if (request.method === "POST" && /\/git\/create-branch\/?$/.test(pathname)) {
    try {
      const b = (await request.clone().json()) as { name?: string };
      const n = typeof b.name === "string" ? b.name.trim() : "";
      if (n.length > 0) {
        createBranchNameFromRequest = n;
      }
    } catch {
      /* ignore: body not JSON or unreadable */
    }
  }

  if (request.method === "POST" && pathname.endsWith("/tr33/preview")) {
    tr33NextLog("POST /tr33/preview: clear active-ref cookie");
    const { cookies } = await import("next/headers");
    const { revalidateTag } = await import("next/cache");
    const { NextResponse } = await import("next/server");
    (await cookies()).delete(TR33_ACTIVE_REF_COOKIE);
    const tag = options?.revalidateTagOnDraftExit;
    if (tag) {
      revalidateTag(tag, "default");
      tr33NextLog("revalidateTag (preview exit)", tag);
    }
    return NextResponse.json({ ok: true });
  }

  const response = await upstream();

  if (pathname.startsWith("/api/vscode/")) {
    const withCors = (res: Response) => withVscodeEmbedCors(request, res);
    if (!response.ok) {
      tr33NextLog("upstream not ok", request.method, pathname, response.status);
      return withCors(response);
    }
  } else if (!response.ok) {
    tr33NextLog("upstream not ok", request.method, pathname, response.status);
    return response;
  }

  const mutationTag = options?.revalidateTagOnDraftExit;
  if (
    mutationTag &&
    request.method === "POST" &&
    /\/git\/(add|commit|discard|merge|pull)\/?$/.test(pathname)
  ) {
    const { revalidateTag } = await import("next/cache");
    revalidateTag(mutationTag, "default");
    tr33NextLog("revalidateTag (git worktree mutation)", pathname, mutationTag);
  }

  let branch: string | undefined;
  let setActiveRefCookie = false;

  if (request.method === "POST" && /\/git\/create-branch\/?$/.test(pathname)) {
    if (createBranchNameFromRequest) {
      branch = createBranchNameFromRequest;
      setActiveRefCookie = true;
    } else {
      try {
        const data = (await response.clone().json()) as { ref?: string };
        if (typeof data.ref === "string") {
          branch = data.ref;
          setActiveRefCookie = true;
        }
      } catch {
        return response;
      }
    }
  } else if (request.method === "GET") {
    const m = pathname.match(/\/git\/worktrees\/([^/]+)\/?$/);
    if (m) {
      branch = decodeURIComponent(m[1]);
      setActiveRefCookie =
        request.headers.get(TR33_SYNC_HOST_ACTIVE_REF_HEADER)?.trim() === "1";
    }
  }

  if (!branch || !setActiveRefCookie) {
    return response;
  }

  tr33NextLog("set tr33-active-ref cookie + response wrap", {
    branch,
    pathname,
    syncHeader:
      request.method === "GET"
        ? request.headers.get(TR33_SYNC_HOST_ACTIVE_REF_HEADER)
        : undefined,
  });

  const cacheTag = options?.revalidateTagOnDraftExit;
  if (cacheTag) {
    const { revalidateTag } = await import("next/cache");
    revalidateTag(cacheTag, "default");
    tr33NextLog("revalidateTag (active ref)", cacheTag);
  }

  const { NextResponse } = await import("next/server");

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.append("Set-Cookie", activeRefSetCookieHeader(branch));

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Next.js App Router entry: one H3 app plus Next-specific response middleware (cookies, cache tags).
 * Use a single bound instance for all HTTP methods so the H3 router is not duplicated.
 *
 * @example
 * ```ts
 * const tr33Api = handle(tr33, { revalidateTagOnDraftExit: "my-tag" });
 * export const GET = tr33Api;
 * export const POST = tr33Api;
 * ```
 */
export function handle(
  client: Tr33Client,
  options?: Tr33NextHandlerOptions,
): (request: Request) => Promise<Response> {
  const { currentRef, ...nextOptions } = options ?? {};
  const app = createHandler(client, { currentRef });
  return (request: Request) =>
    withNextTr33Response(request, () => app.fetch(request), nextOptions);
}

export type { Tr33Client };
export type {
  Tr33KitHostClient,
  Tr33KitProps,
  ToolbarProps,
} from "./tr33-kit";
export { Tr33Kit, Toolbar } from "./tr33-kit";
export {
  TR33_ACTIVE_REF_COOKIE,
  TR33_SYNC_HOST_ACTIVE_REF_HEADER,
  activeRefSetCookieHeader,
} from "./preview-cookies";
export {
  type Tr33ForActiveRef,
  type Tr33RequestCookies,
  cookiesFromCookieHeader,
  resolveActiveRef,
} from "./resolve-active-ref";
export {
  createGitHubAppManifestConversionRoute,
  GitHubAppManifestCallback,
  githubAppManifestConversionCommand,
} from "./github-app-manifest";
export { createTr33PlayAuth } from "./play-auth";
