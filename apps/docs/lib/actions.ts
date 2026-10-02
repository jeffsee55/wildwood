"use server";
import { cookies, draftMode } from "next/headers";
import { refresh } from "next/cache";
import type { Command, CommandResult } from "wildwood-web/next";
import { getContext } from "./wildwood";
import { getWeb } from "./cms";
export async function contentAction(command: Command): Promise<CommandResult> {
  try {
    // The signed ww-view token controls previews. Immutable snapshot reads do not
    // need Next Draft Mode, which bypasses their data cache.
    (await draftMode()).disable();
    if (command.type === "exit") {
      (await cookies()).delete("ww-view");
      refresh();
      return { ok: true, refresh: true };
    }
    const current = await getContext();
    const result = await (await getWeb()).command(current, command);
    if (typeof result.viewToken === "string") {
      (await cookies()).set("ww-view", result.viewToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 86400,
      });
    }
    if (result.refresh) refresh();
    const { viewToken: _token, ...safe } = result;
    return { ok: true, ...safe };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Request failed" };
  }
}
export async function preferences(form: FormData) {
  const ctx = await getContext();
  if (ctx.pinned) return;
  (await draftMode()).disable();
  const jar = await cookies();
  jar.set("ww-locale", form.get("locale") === "fr" ? "fr" : "en", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  refresh();
}
