import { createRoot } from "react-dom/client";
import { Leaf, ArrowLeft } from "lucide-react";
import { AgentPanel } from "./agent/panel";
const context = JSON.parse(document.querySelector("#context")!.textContent!);
createRoot(document.getElementById("agent-root")!).render(
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
      <AgentPanel endpoint={context.endpoint} draft={context.draft ?? undefined} />
    </main>
  </div>,
);
