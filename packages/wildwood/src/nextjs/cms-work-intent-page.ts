import type { WildwoodWorkIntent } from "./work-intent";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderCmsWorkIntentPage(args: {
  endpoint: string;
  project: { org: string; repo: string };
  actor: { name?: string; email?: string };
  intent: WildwoodWorkIntent;
}): string {
  const initial = JSON.stringify({ endpoint: args.endpoint, intent: args.intent }).replaceAll(
    "<",
    "\\u003c",
  );
  const actor = args.actor.name || args.actor.email || "Signed-in user";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Approve edit session · Wildwood</title>
  <style>
    :root { color-scheme:light dark; --bg:#f5f5f2; --card:#fff; --text:#171714; --muted:#6a6a62; --line:#deded7; --accent:#246b45; --accent-soft:#e5f3eb; --danger:#a13b31; }
    @media (prefers-color-scheme:dark){ :root { --bg:#151613; --card:#20211d; --text:#f4f4ed; --muted:#aaa99e; --line:#3b3c35; --accent:#77c99a; --accent-soft:#193a29; --danger:#ef8e83; } }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(680px,100%); background:var(--card); border:1px solid var(--line); border-radius:18px; box-shadow:0 18px 55px rgba(0,0,0,.1); overflow:hidden; }
    header, section, footer { padding:24px 28px; }
    header { border-bottom:1px solid var(--line); }
    h1 { margin:5px 0 4px; font-size:25px; letter-spacing:-.03em; }
    .eyebrow { margin:0; color:var(--accent); font-size:12px; font-weight:750; letter-spacing:.09em; text-transform:uppercase; }
    .muted { color:var(--muted); }
    dl { display:grid; grid-template-columns:112px 1fr; gap:10px 16px; margin:0; }
    dt { color:var(--muted); }
    dd { margin:0; min-width:0; overflow-wrap:anywhere; }
    .summary { margin-top:22px; padding:18px; border:1px solid var(--line); border-radius:12px; background:color-mix(in srgb,var(--card) 84%,var(--bg)); font-size:17px; }
    footer { display:flex; gap:12px; justify-content:flex-end; align-items:center; border-top:1px solid var(--line); }
    button { border:1px solid var(--line); border-radius:10px; padding:10px 15px; background:transparent; color:var(--text); font:inherit; font-weight:700; cursor:pointer; }
    button.primary { border-color:var(--accent); background:var(--accent); color:#fff; }
    button:disabled { opacity:.55; cursor:wait; }
    #result { margin-right:auto; color:var(--muted); }
    #result.error { color:var(--danger); }
    .pill { display:inline-block; padding:3px 8px; border-radius:999px; background:var(--accent-soft); color:var(--accent); font-size:12px; font-weight:750; }
    @media (max-width:540px){ header,section,footer{padding:20px} dl{grid-template-columns:1fr;gap:2px} dd{margin-bottom:10px} footer{align-items:stretch;flex-direction:column} #result{margin:0 0 4px} }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Wildwood edit intent</p>
      <h1>Approve this agent session?</h1>
      <div class="muted">Approval creates a new branch and pins this browser to its preview.</div>
    </header>
    <section>
      <dl>
        <dt>Project</dt><dd>${escapeHtml(args.project.org)}/${escapeHtml(args.project.repo)}</dd>
        <dt>Approving as</dt><dd>${escapeHtml(actor)}</dd>
        <dt>Access</dt><dd>Read and write one server-named branch; request merge</dd>
        <dt>Expires</dt><dd>${escapeHtml(args.intent.expiresAt)}</dd>
      </dl>
      <div class="summary">${escapeHtml(args.intent.summary)}</div>
    </section>
    <footer>
      <span id="result"></span>
      <button id="deny" type="button">Deny</button>
      <button class="primary" id="approve" type="button">Approve and open preview</button>
    </footer>
  </main>
  <script>
    (() => {
      const initial = ${initial};
      const approve = document.querySelector("#approve");
      const deny = document.querySelector("#deny");
      const result = document.querySelector("#result");
      const intent = initial.intent;

      function setDisabled(value) { approve.disabled = value; deny.disabled = value; }
      function show(message, error) { result.textContent = message; result.className = error ? "error" : ""; }

      async function decide(decision) {
        setDisabled(true);
        show(decision === "approve" ? "Creating your branch…" : "Denying…", false);
        try {
          const response = await fetch(initial.endpoint, {
            method:"POST", credentials:"include",
            headers:{ "content-type":"application/json", accept:"application/json" },
            body:JSON.stringify({ decision })
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(body && body.error ? body.error : "Request failed (" + response.status + ")");
          if (decision === "approve" && body.previewUrl) {
            show("Approved. Opening preview…", false);
            location.assign(body.previewUrl);
            return;
          }
          show("Edit session denied.", false);
        } catch (error) {
          setDisabled(false);
          show(error instanceof Error ? error.message : "Could not update this request.", true);
        }
      }

      if (intent.status !== "pending" || Date.parse(intent.expiresAt) <= Date.now()) {
        setDisabled(true);
        show("This edit intent is " + (intent.status === "pending" ? "expired" : intent.status) + ".", false);
      }
      approve.addEventListener("click", () => decide("approve"));
      deny.addEventListener("click", () => decide("deny"));
    })();
  </script>
</body>
</html>`;
}
