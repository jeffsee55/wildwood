import { cookies, draftMode } from "next/headers";
import { revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import { TR33_BRANCH_COOKIE, TR33_CACHE_TAG } from "tr33/nextjs/branch";

export async function GET(req: NextRequest) {
  const branch = req.nextUrl.searchParams.get("branch")?.trim();
  const disable = req.nextUrl.searchParams.get("disable");
  const jar = await cookies();

  if (disable) {
    (await draftMode()).disable();
    jar.delete(TR33_BRANCH_COOKIE);
    jar.delete("x-content-branch");
    jar.delete("tr33-active-ref");
    revalidateTag(TR33_CACHE_TAG, "default");
    revalidateTag("docs-content", "default");
    return NextResponse.json({ draftMode: false });
  }

  if (!branch) {
    return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
  }

  (await draftMode()).enable();
  jar.set(TR33_BRANCH_COOKIE, branch, { path: "/" });
  jar.set("x-content-branch", branch, { path: "/" });
  jar.set("tr33-active-ref", branch, { path: "/" });

  revalidateTag(TR33_CACHE_TAG, "default");
  revalidateTag("docs-content", "default");

  return NextResponse.json({ draftMode: true, branch });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
