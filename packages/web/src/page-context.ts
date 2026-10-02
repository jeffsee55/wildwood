/** Context is a navigation hint, never authority to read a file or redirect off-site. */
export function pageLocation(raw: string, origin: string): string {
  const url = new URL(raw, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Edit page URL must belong to this site");
  // Keep route/query/anchor context without persisting common credentials.
  // Snapshot keys because deletion mutates the live iterator.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const key of [...url.searchParams.keys()])
    if (
      /^(?:token|access_token|refresh_token|id_token|code|state|signature|sig|secret|authorization)$/i.test(
        key,
      )
    )
      url.searchParams.delete(key);
  if (/access_token|id_token|refresh_token/i.test(url.hash)) url.hash = "";
  // An absolute path cannot turn into a protocol-relative redirect.
  return `${url.origin}${url.pathname}${url.search}${url.hash}`;
}
