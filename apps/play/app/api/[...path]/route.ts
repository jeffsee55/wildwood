import { cookiesFromCookieHeader, handle } from "tr33/nextjs";

import { getPlaygroundTr33 } from "@/lib/tr33";

const revalidate = { revalidateTagOnDraftExit: "some-cache-tag" as const };

async function tr33HandlerFor(request: Request) {
  const tr33 = getPlaygroundTr33(
    cookiesFromCookieHeader(request.headers.get("cookie")),
  );
  return handle(tr33, revalidate)(request);
}

export const GET = tr33HandlerFor;
export const HEAD = tr33HandlerFor;
export const OPTIONS = tr33HandlerFor;
/** Git mutations and other Tr33 APIs use POST; Next only forwards exported methods. */
export const POST = tr33HandlerFor;
