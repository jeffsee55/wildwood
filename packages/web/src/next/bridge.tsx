"use client";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
export type Command = { type: string; [key: string]: unknown };
export type CommandResult = {
  ok: boolean;
  error?: string;
  refresh?: boolean;
  [key: string]: unknown;
};
/** This tiny RSC bridge is the only host-compiled client code. The UI is a prebuilt asset. */
export function Toolbar({
  state,
  asset,
  action,
}: {
  state: Record<string, unknown>;
  asset: string;
  action: (command: Command) => Promise<CommandResult>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();
  const actionRef = useRef(action);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);
  const router = useRouter();
  useEffect(() => {
    if (!state.actor || state.mode === "pinned" || state.mode === "shared") return;
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const response = await fetch(`${state.endpoint}/status`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const next = await response.json();
        if (next.snapshot !== stateRef.current.snapshot || next.mode !== stateRef.current.mode)
          router.refresh();
      } catch {
        /* A later poll retries transient connection failures. */
      } finally {
        pending = false;
      }
    };
    const interval = setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [state.actor, state.mode, state.endpoint, router]);
  useEffect(() => {
    const container = root.current!;
    const element = document.createElement("wildwood-toolbar");
    container.append(element);
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ command: Command; done: (value: CommandResult) => void }>
      ).detail;
      startTransition(async () => {
        try {
          const result = await actionRef.current(detail.command);
          detail.done(result);
          if (result.ok && result.refresh) router.refresh();
        } catch {
          detail.done({
            ok: false,
            error:
              "The response was interrupted. Retry the same save to check whether it completed.",
          });
        }
      });
    };
    element.addEventListener("wildwood:command", listener);
    // Import by URL so the host bundler never processes the toolbar or its dependencies.
    const script = document.createElement("script");
    script.type = "module";
    script.src = asset;
    script.addEventListener("error", () => {
      element.textContent = "Wildwood toolbar failed to load.";
    });
    container.append(script);
    return () => {
      element.removeEventListener("wildwood:command", listener);
      element.remove();
      script.remove();
    };
  }, [asset, router]);
  useEffect(() => {
    root.current?.querySelector("wildwood-toolbar")?.setAttribute("state", JSON.stringify(state));
  }, [state, asset, router]);
  return <div ref={root} data-wildwood-bridge="" />;
}
