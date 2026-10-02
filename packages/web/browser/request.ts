/** JSON endpoints may return a proxy error page during a transient deployment failure. */
export async function requestJson(url: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false)
    throw new Error(
      data?.error || `Request interrupted (${response.status}). Retry to check its result.`,
    );
  return data;
}
