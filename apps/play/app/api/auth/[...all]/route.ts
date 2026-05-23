import { toNextJsHandler } from "better-auth/next-js";

import { auth, ensurePlaygroundAuthSchema } from "@/lib/auth";

const handlers = toNextJsHandler(auth);

export async function GET(request: Request) {
  await ensurePlaygroundAuthSchema();
  return handlers.GET(request);
}

export async function POST(request: Request) {
  await ensurePlaygroundAuthSchema();
  return handlers.POST(request);
}
