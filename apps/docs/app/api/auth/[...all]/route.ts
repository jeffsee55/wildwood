import { toNextJsHandler } from "better-auth/next-js";
import { auth, ensureDocsAuthSchema } from "@/lib/auth";

const handlers = toNextJsHandler(auth);

export async function GET(request: Request) {
  await ensureDocsAuthSchema();
  return handlers.GET(request);
}

export async function POST(request: Request) {
  await ensureDocsAuthSchema();
  return handlers.POST(request);
}
