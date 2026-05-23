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
  /** Version segment in asset URLs; paired with immutable cache headers when VS Code updates. */
  vscodeWebVersion: string;
}) => {
  const VSCODE_BASE_URL = `${config.origin}${config.prefix}/vscode-web/${config.vscodeWebVersion}`;
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

    <link rel="apple-touch-icon" href="${VSCODE_BASE_URL}/resources/server/code-192.png" />
    <link rel="icon" href="${VSCODE_BASE_URL}/resources/server/favicon.ico" type="image/x-icon" />
    <link rel="manifest" href="${VSCODE_BASE_URL}/resources/server/manifest.json" crossorigin="use-credentials" />
    <link rel="stylesheet" href="${VSCODE_BASE_URL}/out/vs/code/browser/workbench/workbench.css" />
  </head>

  <body aria-label="" style="background-color: #100F0F;"></body>
  <script>
    const baseUrl = new URL("${VSCODE_BASE_URL}", window.location.origin).toString();
    globalThis._VSCODE_FILE_ROOT = baseUrl + "/out/";
  </script>
  <script type="module" src="${VSCODE_BASE_URL}/out/nls.messages.js"></script>
  <script type="module" src="${VSCODE_BASE_URL}/out/vs/code/browser/workbench/workbench.js"></script>
</html>
`;
};
