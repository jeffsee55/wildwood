import { H3 } from "h3";
import type { WildwoodClient } from "@/client/index";
import { getCode } from "@/nextjs/code";
import {
  stripBuiltInCspMetaFromHtml,
  VSCODE_EMBED_HTML_RESPONSE_HEADERS,
  vscodeEmbedCorsHeaders,
  vscodeEmbedEditorCacheHeaders,
  gitObjectCacheHeaders,
  vscodeWebStaticCacheHeaders,
  withVscodeEmbedCors,
} from "@/nextjs/vscode-embed-csp";
import {
  extensionAssetContentType,
  readBundledExtensionAsset,
} from "@/nextjs/read-bundled-extension-asset";
import {
  getExtensionNlsJson,
  getExtensionPackageJson,
} from "@/nextjs/bundled-extension-bytes.gen";
import { proxyMainVscodeCdnAsset, resolveVscodeWebCdn } from "@/nextjs/vscode-web-cdn";
import { z } from "zod/v4";
import {
  routeParamPath,
  routeParamString,
  resolveEventOrigin,
  resolveVscodeApiPrefix,
  setNoStoreHeaders,
} from "./util";

// Extension manifest is now embedded at build time via
// `scripts/copy-bundled-extension.mjs` → `bundled-extension-bytes.gen.ts`.
// No runtime `require("wildwood-vscode/package.json")` — that breaks under
// Next.js bundling and serverless where node_modules layout != monorepo.

const extensionPkgSchema = z.object({
  name: z.string(),
  publisher: z.string(),
  version: z.string(),
  enabledApiProposals: z.array(z.string()),
});

type H3EventLite = {
  req: Request & { headers: Headers & { get(n: string): string | null } };
  url: URL;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params?: Record<string, any> };
  node?: { res?: { setHeader: (k: string, v: string) => void } };
};

export function createVscodeRouter(client: WildwoodClient): H3 {
  const git = client._.git;
  const repoFull = `${git.config.org}/${git.config.repo}`;
  const ref = git.config.ref;
  const pkg = extensionPkgSchema.parse(getExtensionPackageJson());
  const extensionNls = getExtensionNlsJson();

  const vscode = new H3();
  const getWorkbenchConfig = async (event: H3EventLite) => {
    const origin = resolveEventOrigin(event);
    const dir = resolveVscodeApiPrefix(event.url.pathname);
    const cdn = await resolveVscodeWebCdn();
    return {
      productConfiguration: {
        nameShort: "VSCode Web Sample", nameLong: "VSCode Web sample",
        applicationName: "code-web-sample", dataFolderName: ".vscode-web-sample",
        version: cdn.version, commit: cdn.commit,
        webEndpointUrl: `${origin}${dir}/cdn/${cdn.commit}`,
        webEndpointUrlTemplate: `${origin}${dir}/cdn/${cdn.commit}`,
        extensionsGallery: {
          serviceUrl: "https://open-vsx.org/vscode/gallery",
          itemUrl: "https://open-vsx.org/vscode/item",
          resourceUrlTemplate: "https://openvsxorg.blob.core.windows.net/resources/{publisher}/{name}/{version}/{path}",
          controlUrl: `${origin}${dir}/extensions/marketplace.json`,
        },
        chatParticipantRegistry: `${origin}${dir}/extensions/chat.json`,
        extensionEnabledApiProposals: {
          [`${pkg.publisher}.${pkg.name}`]: pkg.enabledApiProposals,
          nullExtensionDescription: pkg.enabledApiProposals,
        },
      },
      folderUri: { scheme: "wildwood-vfs", authority: event.url.host, path: "/" },
      additionalBuiltinExtensions: [{ scheme: event.url.protocol.replace(":", ""), authority: event.url.host, path: `${dir}/extension` }],
      configurationDefaults: {
        "workbench.colorTheme": "Wildwood Dark", "wildwood.repo": repoFull, "wildwood.headRef": ref, "wildwood.baseRef": ref,
        "workbench.editorAssociations": {
          "*.png": "wildwood.imagePreview", "*.jpg": "wildwood.imagePreview", "*.jpeg": "wildwood.imagePreview",
          "*.gif": "wildwood.imagePreview", "*.webp": "wildwood.imagePreview", "*.svg": "wildwood.imagePreview", "*.bmp": "wildwood.imagePreview", "*.ico": "wildwood.imagePreview",
        },
      },
    } as const;
  };

  const serveWildwoodExtensionAsset = async (event: H3EventLite, asset: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setNoStoreHeaders(event as any);
    try {
      if (asset === "package.json") {
        // MUST serve the full manifest (contributes, activationEvents, browser, etc).
        // Previously referenced undeclared `extensionPkgRaw` — the refactor to embedded bytes
        // left that identifier behind, causing Runtime: ReferenceError and 500-ing all assets
        // because the catch-all `extension/**` route resolved `package.json` through this path.
        //
        // We intentionally read via `readBundledExtensionAsset` (FS → bundled-extension/package.json
        // → embedded full bytes fallback) so a stale `*.gen.ts` cannot break prod. The file
        // `packages/wildwood/bundled-extension/package.json` is shipped via `files` in package.json
        // and also exists as node_modules/wildwood/bundled-extension in Vercel.
        const bytes = await readBundledExtensionAsset("package.json");
        if (bytes) {
          try {
            const text = new TextDecoder("utf-8").decode(bytes);
            const full = JSON.parse(text) as Record<string, unknown>;
            return withVscodeEmbedCors(
              event.req,
              Response.json(full, { headers: { "content-type": "application/json" } }),
            );
          } catch {
            // fall through to minimal fallback below
          }
        }
        // Absolute fallback  — still return something rather than 500 so editor loads degraded.
        return withVscodeEmbedCors(
          event.req,
          Response.json(pkg as unknown as Record<string, unknown>, {
            headers: { "content-type": "application/json", "x-wildwood-fallback": "minimal-pkg" },
          }),
        );
      }
      if (asset === "package.nls.json") {
        // Prefer embedded NLS (works offline), falls through to bundling
        return withVscodeEmbedCors(
          event.req,
          Response.json(extensionNls as unknown as Record<string, unknown>, { headers: { "content-type": "application/json" } }),
        );
      }
      const bytes = await readBundledExtensionAsset(asset);
      if (!bytes) {
        console.error("[wildwood:vscode] extension asset not found:", asset);
        return new Response("Not found", { status: 404, headers: vscodeEmbedCorsHeaders(event.req) });
      }
      const ct = extensionAssetContentType(asset);
      const headers = new Headers(vscodeEmbedCorsHeaders(event.req));
      if (ct) headers.set("content-type", ct);
      headers.set("cache-control", "no-store");
      return new Response(bytes as unknown as BodyInit, { status: 200, headers });
    } catch (e) {
      console.error("[wildwood:vscode] extension asset failed:", asset, e);
      return new Response(`Failed to load extension asset: ${e instanceof Error ? e.message : String(e)}`, { status: 500, headers: vscodeEmbedCorsHeaders(event.req) });
    }
  };

  vscode.use(async (event, next) => {
    const corsHeaders = vscodeEmbedCorsHeaders(event.req);
    if (event.req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const res = await next();
    if (res instanceof Response) return withVscodeEmbedCors(event.req, res);
    return res;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serveEditorHtml = async (event: any, commitParam?: string) => {
    const cdn = await resolveVscodeWebCdn();
    if (commitParam && commitParam !== cdn.commit) return new Response("VS Code commit mismatch", { status: 404 });
    const wc = await getWorkbenchConfig(event as H3EventLite);
    const code = getCode({ origin: resolveEventOrigin(event as H3EventLite), prefix: "/api/vscode", workbenchConfig: wc as never, vscodeWebCdn: cdn as never });
    return new Response(code, { status: 200, headers: vscodeEmbedEditorCacheHeaders(cdn.commit) });
  };

  vscode
    .get("/editor/:commit", async (event) => {
      const cp = routeParamString((event.context.params as Record<string, unknown>)?.commit as string | number | undefined);
      if (!cp) return new Response("VS Code commit required", { status: 400 });
      return serveEditorHtml(event, cp);
    })
    .get("/editor", async (event) => serveEditorHtml(event))
    .get("/product.json", async (event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setNoStoreHeaders(event as any);
      return Response.json(await getWorkbenchConfig(event as H3EventLite));
    })
    .get("extensions/**:asset", async (event) => {
      const asset = routeParamPath((event.context.params as Record<string, unknown>)?.asset as string | string[] | number | undefined);
      if (!asset) return new Response("No asset path", { status: 404, headers: vscodeEmbedCorsHeaders(event.req) });
      // proxyMainVscodeCdnAsset sig varies; coerce via any here
      return (proxyMainVscodeCdnAsset as unknown as (req: unknown, p: string) => unknown)(event.req as unknown, `extensions/${asset}`) as never;
    })
    .get("/extension/package.json", async (event) => serveWildwoodExtensionAsset(event as H3EventLite, "package.json"))
    .get("extension/**:asset", async (event) => {
      const asset = routeParamPath((event.context.params as Record<string, unknown>)?.asset as string | string[] | number | undefined);
      if (!asset) return new Response("No asset path", { status: 404, headers: vscodeEmbedCorsHeaders(event.req) });
      return serveWildwoodExtensionAsset(event as H3EventLite, asset);
    });

  vscode.get("/object-tree/:oid", async (event) => {
    const oid = routeParamString((event.context.params as Record<string, unknown>)?.oid as string | number | undefined);
    if (!oid) return new Response("Missing oid", { status: 400 });
    const tree = await git.getTree(oid);
    if (!tree) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(tree), { headers: { "Content-Type": "application/json", ...gitObjectCacheHeaders(oid) } });
  });

  const vscodeCdn = new H3();
  vscodeCdn.get("/:commit/**:asset", async (event) => {
    const asset = routeParamPath((event.context.params as Record<string, unknown>)?.asset as string | string[] | number | undefined);
    const commitParam = routeParamString((event.context.params as Record<string, unknown>)?.commit as string | number | undefined);
    if (!asset || !commitParam) return new Response("No asset path", { status: 404 });
    const cdn = await resolveVscodeWebCdn();
    if (commitParam !== cdn.commit) return new Response("VS Code commit mismatch", { status: 404 });
    const cdnUrl = `${cdn.cdnBase}/${asset.replace(/^\/+/, "")}`;
    const range = event.req.headers.get("range");
    const upstream = await fetch(cdnUrl, { method: event.req.method === "HEAD" ? "HEAD" : "GET", headers: { "Accept-Encoding": "identity", ...(range ? { Range: range } : {}) } });
    if (!upstream.ok) return new Response("Not found", { status: upstream.status });
    const lower = asset.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      if (event.req.method === "HEAD") return new Response(null, { status: upstream.status, headers: VSCODE_EMBED_HTML_RESPONSE_HEADERS });
      let contents = await upstream.text();
      contents = stripBuiltInCspMetaFromHtml(contents);
      return new Response(contents, { headers: VSCODE_EMBED_HTML_RESPONSE_HEADERS });
    }
    const headers = new Headers();
    const passthrough = ["content-type", "content-range", "accept-ranges", "etag", "last-modified"] as const;
    for (const n of passthrough) { const v = upstream.headers.get(n); if (v) headers.set(n, v); }
    for (const [k, v] of Object.entries(vscodeWebStaticCacheHeaders(cdn.commit))) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  });
  vscodeCdn.get("/", async (event) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setNoStoreHeaders(event as any);
    const cdn = await resolveVscodeWebCdn();
    const base = event.url.pathname.replace(/\/$/, "");
    return Response.redirect(`${resolveEventOrigin(event as unknown as H3EventLite)}${base}/${cdn.commit}/out/vs/code/browser/workbench/workbench.html`, 302);
  });
  vscode.mount("/cdn", vscodeCdn);

  return vscode;
}
