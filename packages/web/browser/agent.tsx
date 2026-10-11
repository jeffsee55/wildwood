import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Leaf, ArrowLeft } from "lucide-react";
import { AgentPanel } from "./agent/panel";
import { watchWorkspace } from "../src/workspace-sync";
const context = JSON.parse(document.querySelector("#context")!.textContent!);
function Workspace() {
  const [draft, setDraft] = useState<string | undefined>(context.draft ?? undefined);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let queued = false;
    const check = async () => {
      if (document.hidden || controller.signal.aborted) return;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      try {
        const response = await fetch(`${context.endpoint}/status`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) setDraft((await response.json()).draft);
      } catch {
        /* The next poll retries transient failures. */
      } finally {
        pending = false;
        if (queued) {
          queued = false;
          void check();
        }
      }
    };
    const unwatch = watchWorkspace(check);
    const interval = setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(interval);
      unwatch();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return (
    <div className="agent-workspace">
      <nav>
        <a href="/">
          <Leaf size={18} /> wildwood <span>/ agent</span>
        </a>
        <a href={`${context.endpoint}/connect`}>Connect an external agent</a>
      </nav>
      <main>
        <a className="agent-back" href="/">
          <ArrowLeft size={13} />
          Back to content
        </a>
        <AgentPanel
          endpoint={context.endpoint}
          draft={draft}
          initialConfig={context.initialConfig}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("agent-root")!).render(<Workspace />);
