import type { WildwoodApprovalRequest } from "./access";

export type CmsApprovalPageData = {
  endpoint: string;
  project: { org: string; repo: string };
  actor: { name?: string; email?: string };
  approval: WildwoodApprovalRequest;
};

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function renderCmsApprovalPage(data: CmsApprovalPageData): string {
  const initialData = jsonForInlineScript(data);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Merge approval · Wildwood CMS</title>
  <style>
    :root { color-scheme:light dark; --bg:#f6f6f4; --panel:#fff; --text:#181817; --muted:#6d6d68; --line:#deded9; --accent:#2f6d52; --accent-bg:#e9f5ee; --danger:#b42318; --danger-bg:#fff1ef; --warning:#8a5a00; --warning-bg:#fff8e5; }
    @media (prefers-color-scheme:dark) { :root { --bg:#111210; --panel:#191a18; --text:#efefe9; --muted:#a1a19a; --line:#353631; --accent:#8bd0ad; --accent-bg:#183125; --danger:#ff8a80; --danger-bg:#321b19; --warning:#f4c76b; --warning-bg:#302711; } }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(100% - 32px,720px); margin:0 auto; padding:48px 0 80px; }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:24px; }
    h1 { margin:0; font-size:24px; line-height:1.2; letter-spacing:-.02em; }
    h2 { margin:0; font-size:15px; }
    p { margin:0; color:var(--muted); }
    a { color:inherit; }
    code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .eyebrow { margin-bottom:8px; color:var(--muted); font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    .repo,.actor { margin-top:7px; color:var(--muted); font-size:12px; }
    .card { margin-top:16px; overflow:hidden; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:0 1px 2px rgb(0 0 0 / .03); }
    .card-section { padding:20px; }
    .card-section + .card-section { border-top:1px solid var(--line); }
    .headline { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .pill { padding:4px 8px; border-radius:999px; background:var(--warning-bg); color:var(--warning); font-size:11px; font-weight:700; text-transform:capitalize; }
    .pill.approved { background:var(--accent-bg); color:var(--accent); }
    .pill.denied,.pill.expired { background:var(--danger-bg); color:var(--danger); }
    .route { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:12px; margin-top:18px; }
    .ref { min-width:0; padding:12px; border:1px solid var(--line); border-radius:9px; background:var(--bg); }
    .ref span { display:block; margin-bottom:4px; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }
    .ref code { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .arrow { color:var(--muted); }
    dl { display:grid; grid-template-columns:112px minmax(0,1fr); gap:10px 16px; margin:0; }
    dt { color:var(--muted); font-size:12px; }
    dd { min-width:0; margin:0; overflow-wrap:anywhere; }
    .reason { margin-top:16px; padding:12px; border-left:3px solid var(--line); background:var(--bg); color:var(--text); }
    .scope { display:grid; gap:9px; margin:14px 0 0; padding:0; list-style:none; }
    .scope li { position:relative; padding-left:20px; color:var(--muted); }
    .scope li::before { position:absolute; left:1px; top:3px; color:var(--accent); font-weight:800; content:"✓"; }
    .scope strong { color:var(--text); }
    .actions { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .actions-right { display:flex; gap:8px; }
    button { min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:7px; background:var(--panel); color:var(--text); font:600 12px inherit; cursor:pointer; }
    button:hover:not(:disabled) { filter:brightness(.96); }
    button:disabled { cursor:not-allowed; opacity:.5; }
    button.approve { border-color:var(--accent); background:var(--accent); color:#fff; }
    button.deny { color:var(--danger); }
    .status { display:none; padding:12px; border:1px solid var(--line); border-radius:9px; background:var(--bg); }
    .status.visible { display:block; }
    .status.success { border-color:color-mix(in srgb,var(--accent) 38%,var(--line)); background:var(--accent-bg); }
    .status.error { border-color:color-mix(in srgb,var(--danger) 38%,var(--line)); background:var(--danger-bg); }
    .status strong { display:block; margin-bottom:3px; }
    .status p { font-size:12px; }
    @media (max-width:600px) { main { padding-top:28px; } header { display:block; } .route { grid-template-columns:1fr; } .arrow { transform:rotate(90deg); text-align:center; } dl { grid-template-columns:1fr; gap:3px; } dd + dt { margin-top:7px; } .actions { align-items:stretch; flex-direction:column; } .actions-right { display:grid; grid-template-columns:1fr 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Wildwood CMS · Permission request</div>
        <h1>Approve this merge?</h1>
        <div class="repo" id="repo"></div>
        <div class="actor" id="actor"></div>
      </div>
      <a href="/">Return to site</a>
    </header>

    <section class="card" aria-labelledby="request-title">
      <div class="card-section">
        <div class="headline"><h2 id="request-title">Agent merge request</h2><span class="pill" id="status-pill"></span></div>
        <div class="route">
          <div class="ref"><span>Source branch</span><code id="source-ref"></code></div>
          <div class="arrow" aria-hidden="true">→</div>
          <div class="ref"><span>Target branch</span><code id="target-ref"></code></div>
        </div>
        <div class="reason" id="reason"></div>
      </div>
      <div class="card-section">
        <dl>
          <dt>Source commit</dt><dd><code id="commit"></code></dd>
          <dt>Requested by</dt><dd><code id="requested-by"></code></dd>
          <dt>Requested</dt><dd id="created-at"></dd>
          <dt>Expires</dt><dd id="expires-at"></dd>
        </dl>
      </div>
      <div class="card-section">
        <h2>What approval grants</h2>
        <ul class="scope">
          <li><strong>One merge attempt</strong>, then the permission is consumed.</li>
          <li><strong>This exact commit only.</strong> A new commit requires another approval.</li>
          <li><strong>This branch into this target only.</strong> It grants no general access to the protected branch.</li>
          <li><strong>Short lived.</strong> The permission expires with this request.</li>
        </ul>
      </div>
      <div class="card-section">
        <div class="status" id="result" role="status" aria-live="polite"><strong id="result-title"></strong><p id="result-detail"></p></div>
        <div class="actions" id="actions">
          <p>Review the immutable scope above before continuing.</p>
          <div class="actions-right">
            <button class="deny" id="deny" type="button">Deny</button>
            <button class="approve" id="approve" type="button">Approve once</button>
          </div>
        </div>
      </div>
    </section>
  </main>
  <script>
    (() => {
      const initial = ${initialData};
      const approval = initial.approval;
      const pill = document.querySelector("#status-pill");
      const actions = document.querySelector("#actions");
      const result = document.querySelector("#result");
      const approve = document.querySelector("#approve");
      const deny = document.querySelector("#deny");
      const formatDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(value));

      document.querySelector("#repo").textContent = initial.project.org + "/" + initial.project.repo;
      document.querySelector("#actor").textContent = "Signed in as " + (initial.actor.name || initial.actor.email || "project owner");
      document.querySelector("#source-ref").textContent = approval.sourceRef;
      document.querySelector("#target-ref").textContent = approval.targetRef;
      document.querySelector("#commit").textContent = approval.sourceCommit;
      document.querySelector("#requested-by").textContent = approval.requestedBy;
      document.querySelector("#created-at").textContent = formatDate(approval.createdAt);
      document.querySelector("#expires-at").textContent = formatDate(approval.expiresAt);
      document.querySelector("#reason").textContent = approval.reason || "The agent did not provide a reason.";

      function setStatus(status) {
        pill.textContent = status;
        pill.className = "pill " + status;
        if (status !== "pending") actions.hidden = true;
      }

      function showResult(kind, title, detail) {
        result.className = "status visible " + kind;
        document.querySelector("#result-title").textContent = title;
        document.querySelector("#result-detail").textContent = detail;
      }

      async function decide(decision) {
        approve.disabled = true;
        deny.disabled = true;
        showResult("", decision === "approve" ? "Issuing one-time permission…" : "Denying request…", "Keeping the approval bound to this branch and commit.");
        try {
          const response = await fetch(initial.endpoint, {
            method:"POST", credentials:"include",
            headers:{ "content-type":"application/json", accept:"application/json" },
            body:JSON.stringify({ decision })
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(body && body.error ? body.error : "Request failed (" + response.status + ")");
          setStatus(body.approval.status);
          showResult(
            decision === "approve" ? "success" : "",
            decision === "approve" ? "Approved for one attempt" : "Merge denied",
            decision === "approve" ? "The agent can retry this exact merge now." : "No merge permission was issued."
          );
        } catch (error) {
          approve.disabled = false;
          deny.disabled = false;
          showResult("error", "Decision not saved", error instanceof Error ? error.message : "Could not update this request.");
        }
      }

      const effectiveStatus = approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.now() ? "expired" : approval.status;
      setStatus(effectiveStatus);
      if (effectiveStatus !== "pending") {
        const detail = effectiveStatus === "approved" ? "A one-time permission was already issued for this merge." : "This request can no longer issue merge permission.";
        showResult(effectiveStatus === "approved" ? "success" : "", "Request " + effectiveStatus, detail);
      }
      approve.addEventListener("click", () => decide("approve"));
      deny.addEventListener("click", () => decide("deny"));
    })();
  </script>
</body>
</html>`;
}
