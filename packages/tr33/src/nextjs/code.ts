import type { VscodeWebCdn } from "@/nextjs/vscode-web-cdn";
import { vscodeCdnProxyAssetUrl } from "@/nextjs/vscode-web-cdn";

const escapeHtmlAttr = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

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

  <body aria-label="" style="background-color: #100F0F;"></body>
  <script>
    globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(fileRoot)};
  </script>
  <script type="module" src="${asset("out/nls.messages.js")}"></script>
  <script type="module" src="${asset("out/vs/workbench/workbench.web.main.internal.js")}"></script>
</html>
`;
};
