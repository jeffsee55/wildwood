import type { WildwoodDatabaseStats } from "@/sqlite/database";

export type CmsDatabasePageData = {
  endpoint: string;
  project: { org: string; repo: string };
  stats: WildwoodDatabaseStats;
};

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function renderCmsDatabasePage(data: CmsDatabasePageData): string {
  const initialData = jsonForInlineScript(data);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Database · Wildwood CMS</title>
  <style>
    :root { color-scheme: light dark; --bg:#f6f6f4; --panel:#fff; --text:#181817; --muted:#6d6d68; --line:#deded9; --danger:#b42318; --danger-bg:#fff1ef; --accent:#2f6d52; --accent-bg:#e9f5ee; }
    @media (prefers-color-scheme:dark) { :root { --bg:#111210; --panel:#191a18; --text:#efefe9; --muted:#a1a19a; --line:#353631; --danger:#ff8a80; --danger-bg:#321b19; --accent:#8bd0ad; --accent-bg:#183125; } }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(100% - 32px,760px); margin:0 auto; padding:48px 0 80px; }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:24px; }
    h1 { margin:0; font-size:24px; line-height:1.2; letter-spacing:-.02em; }
    h2 { margin:0 0 6px; font-size:15px; }
    p { margin:0; color:var(--muted); }
    a { color:inherit; }
    .eyebrow { margin-bottom:8px; color:var(--muted); font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    .repo { margin-top:7px; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); }
    .card { margin-top:16px; padding:20px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:0 1px 2px rgb(0 0 0 / .03); }
    .card-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:1px; overflow:hidden; border:1px solid var(--line); border-radius:9px; background:var(--line); }
    .stat { min-width:0; padding:12px; background:var(--panel); }
    .stat span { display:block; overflow:hidden; color:var(--muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
    .stat strong { display:block; margin-top:2px; font:600 16px ui-monospace,SFMono-Regular,Menlo,monospace; }
    button { min-height:34px; padding:7px 11px; border:1px solid var(--line); border-radius:7px; background:var(--panel); color:var(--text); font:600 12px inherit; cursor:pointer; }
    button:hover:not(:disabled) { filter:brightness(.96); }
    button:disabled { cursor:not-allowed; opacity:.5; }
    button.danger { border-color:color-mix(in srgb,var(--danger) 38%,var(--line)); background:var(--danger-bg); color:var(--danger); }
    input { width:100%; margin-top:7px; padding:9px 10px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--text); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; outline:none; }
    input:focus { border-color:var(--danger); box-shadow:0 0 0 3px color-mix(in srgb,var(--danger) 16%,transparent); }
    .danger-copy { max-width:610px; }
    .confirm { display:none; margin-top:16px; }
    .confirm.visible { display:block; }
    .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
    .status { display:none; margin-top:16px; padding:14px; border:1px solid var(--line); border-radius:9px; background:var(--bg); }
    .status.visible { display:block; }
    .status.success { border-color:color-mix(in srgb,var(--accent) 38%,var(--line)); background:var(--accent-bg); }
    .status.error { border-color:color-mix(in srgb,var(--danger) 38%,var(--line)); background:var(--danger-bg); }
    .status-line { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    #status-title { font-weight:650; }
    #status-detail { margin-top:4px; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); overflow-wrap:anywhere; }
    progress { width:100%; height:6px; margin-top:12px; border:0; accent-color:var(--accent); }
    .timeline { margin:12px 0 0; padding:0; list-style:none; color:var(--muted); font-size:11px; }
    .timeline li { position:relative; padding:3px 0 3px 15px; }
    .timeline li::before { position:absolute; left:1px; top:9px; width:5px; height:5px; border-radius:50%; background:currentColor; content:""; }
    .complete-actions { display:none; margin-top:14px; }
    .complete-actions.visible { display:flex; gap:12px; align-items:center; }
    .note { margin-top:12px; font-size:11px; }
    @media (max-width:640px) { main { padding-top:28px; } header { display:block; } .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .card { padding:16px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Wildwood CMS</div>
        <h1>Database</h1>
        <div class="repo" id="repo"></div>
      </div>
      <a href="/">Return to site</a>
    </header>

    <section class="card" aria-labelledby="overview-title">
      <div class="card-head">
        <div><h2 id="overview-title">Current contents</h2><p>Counts across the shared Wildwood database.</p></div>
        <button id="refresh" type="button">Refresh</button>
      </div>
      <div class="grid" id="stats"></div>
    </section>

    <section class="card" aria-labelledby="reset-title">
      <h2 id="reset-title" style="color:var(--danger)">Reset database</h2>
      <p class="danger-copy">This deletes Better Auth users and sessions, managed access data, and indexed Git data for every repository. The signing secret is retained, but your current session is revoked.</p>
      <div class="actions" id="initial-actions"><button class="danger" id="begin" type="button">Reset database…</button></div>
      <div class="confirm" id="confirm">
        <label for="confirmation">Type <code>wipe all wildwood data</code> to continue.</label>
        <input id="confirmation" autocomplete="off" spellcheck="false">
        <div class="actions">
          <button id="cancel" type="button">Cancel</button>
          <button class="danger" id="reset" type="button" disabled>Reset everything</button>
        </div>
      </div>
      <div class="status" id="status" role="status" aria-live="polite">
        <div class="status-line"><span id="status-title">Preparing reset…</span><span id="status-count"></span></div>
        <div id="status-detail"></div>
        <progress id="progress"></progress>
        <ol class="timeline" id="timeline"></ol>
      </div>
      <div class="complete-actions" id="complete-actions"><a href="/">Return to the site and sign in again</a></div>
      <p class="note">This page is served directly by Wildwood and remains available while site content is being deleted.</p>
    </section>
  </main>
  <script>
    (() => {
      const initial = ${initialData};
      const phrase = "wipe all wildwood data";
      const labels = { users:"Users", sessions:"Sessions", projects:"Projects", grants:"Grants", credentials:"Credentials", approvals:"Approvals", authEvents:"Auth events", refs:"Refs", commits:"Commits", entries:"Entries" };
      const statsNode = document.querySelector("#stats");
      const confirmNode = document.querySelector("#confirm");
      const initialActions = document.querySelector("#initial-actions");
      const confirmation = document.querySelector("#confirmation");
      const resetButton = document.querySelector("#reset");
      const statusNode = document.querySelector("#status");
      const statusTitle = document.querySelector("#status-title");
      const statusCount = document.querySelector("#status-count");
      const statusDetail = document.querySelector("#status-detail");
      const progress = document.querySelector("#progress");
      const timeline = document.querySelector("#timeline");
      document.querySelector("#repo").textContent = initial.project.org + "/" + initial.project.repo;

      function renderStats(stats) {
        statsNode.replaceChildren();
        Object.keys(labels).forEach((key) => {
          const cell = document.createElement("div");
          cell.className = "stat";
          const label = document.createElement("span");
          label.textContent = labels[key];
          const value = document.createElement("strong");
          value.textContent = Number(stats[key] || 0).toLocaleString();
          cell.append(label, value);
          statsNode.append(cell);
        });
      }

      function addEvent(message) {
        const item = document.createElement("li");
        item.textContent = message;
        timeline.append(item);
      }

      function friendlyTable(table) {
        return String(table || "database").replace(/^wildwood_/, "").replace(/^_/, "").replaceAll("_", " ");
      }

      function handleProgress(event) {
        if (event.phase === "clearing") {
          statusTitle.textContent = "Clearing database";
          statusCount.textContent = event.completed + " / " + event.total;
          statusDetail.textContent = friendlyTable(event.table);
          progress.max = event.total;
          progress.value = event.completed;
        } else if (event.phase === "initializing") {
          statusTitle.textContent = "Restoring empty schema";
          statusCount.textContent = "";
          statusDetail.textContent = "Recreating and verifying Wildwood tables";
          progress.removeAttribute("value");
          addEvent("All stored data cleared");
        } else if (event.phase === "complete") {
          statusTitle.textContent = "Database reset complete";
          statusCount.textContent = "";
          statusDetail.textContent = "Your session was deleted. Sign in again to reclaim bootstrap ownership.";
          progress.max = 1;
          progress.value = 1;
          statusNode.classList.add("success");
          document.querySelector("#complete-actions").classList.add("visible");
          addEvent("Empty schema ready; session revoked");
        } else if (event.phase === "error") {
          throw new Error(event.message || "Database reset failed");
        }
      }

      async function responseError(response) {
        const body = await response.json().catch(() => null);
        return body && body.error ? body.error : "Request failed (" + response.status + ")";
      }

      async function refresh() {
        const button = document.querySelector("#refresh");
        button.disabled = true;
        try {
          const response = await fetch(initial.endpoint, { credentials:"include", headers:{ accept:"application/json" } });
          if (!response.ok) throw new Error(await responseError(response));
          const data = await response.json();
          renderStats(data.database.stats);
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "Could not refresh database stats");
        } finally {
          button.disabled = false;
        }
      }

      async function reset() {
        resetButton.disabled = true;
        document.querySelector("#cancel").disabled = true;
        confirmation.disabled = true;
        statusNode.className = "status visible";
        timeline.replaceChildren();
        statusTitle.textContent = "Authorizing reset";
        statusDetail.textContent = "Keeping this management page open while the database changes";
        progress.removeAttribute("value");
        addEvent("Reset submitted by bootstrap owner");
        try {
          const response = await fetch(initial.endpoint, {
            method:"POST",
            credentials:"include",
            headers:{ "content-type":"application/json", accept:"application/x-ndjson" },
            body:JSON.stringify({ confirm:phrase })
          });
          if (!response.ok) throw new Error(await responseError(response));
          if (!response.body) throw new Error("The reset stream was unavailable");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffered = "";
          while (true) {
            const result = await reader.read();
            buffered += decoder.decode(result.value || new Uint8Array(), { stream:!result.done });
            const lines = buffered.split("\\n");
            buffered = lines.pop() || "";
            lines.filter(Boolean).forEach((line) => handleProgress(JSON.parse(line)));
            if (result.done) break;
          }
          if (buffered.trim()) handleProgress(JSON.parse(buffered));
          renderStats(Object.fromEntries(Object.keys(labels).map((key) => [key, 0])));
          confirmNode.classList.remove("visible");
        } catch (error) {
          statusNode.classList.add("error");
          statusTitle.textContent = "Reset stopped";
          statusCount.textContent = "";
          statusDetail.textContent = error instanceof Error ? error.message : "Database reset failed";
          progress.removeAttribute("value");
          resetButton.disabled = confirmation.value !== phrase;
          document.querySelector("#cancel").disabled = false;
          confirmation.disabled = false;
        }
      }

      renderStats(initial.stats);
      document.querySelector("#refresh").addEventListener("click", refresh);
      document.querySelector("#begin").addEventListener("click", () => { initialActions.hidden = true; confirmNode.classList.add("visible"); confirmation.focus(); });
      document.querySelector("#cancel").addEventListener("click", () => { confirmNode.classList.remove("visible"); initialActions.hidden = false; confirmation.value = ""; resetButton.disabled = true; });
      confirmation.addEventListener("input", () => { resetButton.disabled = confirmation.value !== phrase; });
      confirmation.addEventListener("keydown", (event) => { if (event.key === "Enter" && !resetButton.disabled) reset(); });
      resetButton.addEventListener("click", reset);
    })();
  </script>
</body>
</html>`;
}
