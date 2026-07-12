/** Request origin for absolute URLs (FastURL may lack origin behind proxies). */
export const resolveEventOrigin = (event: {
  url: URL;
  req: { headers: { get: (name: string) => string | null } };
}): string => {
  const { origin } = event.url;
  if (origin && origin !== "null") return origin;
  const host =
    event.req.headers.get("x-forwarded-host") ??
    event.req.headers.get("host");
  if (!host) return "http://localhost";
  const proto =
    event.req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
};

/** Stable mount prefix (`/api/vscode`), regardless of `/editor` or `/editor/:commit`. */
export const resolveVscodeApiPrefix = (pathname: string): string => {
  const marker = "/vscode";
  const i = pathname.indexOf(marker);
  if (i < 0) return "/api/vscode";
  return pathname.slice(0, i + marker.length);
};

/** H3 may coerce all-digit path params to numbers (e.g. GitHub installation ids). */
export const routeParamString = (value: string | number | undefined): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return String(value);
};

export const routeParamPath = (
  value: string | number | string[] | undefined,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String).join("/");
  return String(value);
};

export const setNoStoreHeaders = (event: {
  node?: { res?: { setHeader: (k: string, v: string) => void } };
}) => {
  event.node?.res?.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  event.node?.res?.setHeader("pragma", "no-cache");
  event.node?.res?.setHeader("expires", "0");
};
