import { TR33_ACTIVE_REF_STORAGE_KEY } from "@/nextjs/active-ref-storage";
import type { VscodeWebCdn } from "@/nextjs/vscode-web-cdn";
import { vscodeCdnProxyAssetUrl } from "@/nextjs/vscode-web-cdn";

const escapeHtmlAttr = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Safe JSON inside `<script>` (not HTML attributes). */
const jsonForScript = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

export const getCode = (config: {
  origin: string;
  prefix: string;
  workbenchConfig: object;
  vscodeWebCdn: VscodeWebCdn;
}) => {
  const { commit } = config.vscodeWebCdn;
  const asset = (path: string) =>
    vscodeCdnProxyAssetUrl(config.origin, config.prefix, commit, path);
  const fileRoot = `${asset("out")}/`;
  const workbenchModule = asset(
    "out/vs/workbench/workbench.web.main.internal.js",
  );
  const configJson = escapeHtmlAttr(JSON.stringify(config.workbenchConfig));
  const emptyAuthSession = escapeHtmlAttr(JSON.stringify({}));
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Code" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no"
    />

    <meta id="vscode-workbench-web-configuration" data-settings="${configJson}" />
    <meta id="vscode-workbench-auth-session" data-settings="${emptyAuthSession}" />

    <link rel="apple-touch-icon" href="${asset("code-192.png")}" />
    <link rel="icon" href="${asset("favicon.ico")}" type="image/x-icon" />
    <link rel="manifest" href="${asset("manifest.json")}" crossorigin="use-credentials" />
    <link rel="stylesheet" href="${asset("out/vs/workbench/workbench.web.main.internal.css")}" />
  </head>

  <body aria-label="" style="margin:0;overflow:hidden;background-color:#100F0F;"></body>
  <script>
    globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(fileRoot)};
  </script>
  <script type="module" src="${asset("out/nls.messages.js")}"></script>
  <script type="module">
    import { create } from ${jsonForScript(workbenchModule)};
    const config = JSON.parse(
      document.getElementById("vscode-workbench-web-configuration").getAttribute("data-settings"),
    );
    try {
      const storedRef = localStorage.getItem(${JSON.stringify(TR33_ACTIVE_REF_STORAGE_KEY)});
      if (typeof storedRef === "string" && storedRef.trim().length > 0) {
        config.configurationDefaults = config.configurationDefaults ?? {};
        config.configurationDefaults["tr33.headRef"] = storedRef.trim();
      }
    } catch {
      /* private mode / blocked storage */
    }
    const workspace = config.folderUri ? { folderUri: config.folderUri } : undefined;
    await create(document.body, {
      ...config,
      workspaceProvider: {
        workspace,
        trusted: true,
        async open() {
          return true;
        },
      },
    });
  </script>
</html>
`;
};
