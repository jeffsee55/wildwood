/* oxlint-disable unicorn/prefer-add-event-listener -- Each freshly rendered control owns exactly one handler. */
const ctx = JSON.parse(document.querySelector("#context").textContent);
const status = document.querySelector("#status");
function oauthQuery() {
  const source = new URLSearchParams(location.search);
  const keys = new Set(source.getAll("ba_param"));
  if (!source.has("sig") || !keys.size) return undefined;
  const query = new URLSearchParams();
  for (const [key, value] of source) if (key === "sig" || keys.has(key)) query.append(key, value);
  return query.toString();
}
async function request(path, body) {
  const res = await fetch(ctx.endpoint + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await res.json();
  if (!res.ok || value.ok === false)
    throw new Error(value.error?.message || value.error || "Request failed");
  return value;
}
async function run(fn) {
  try {
    status.textContent = "Working…";
    await fn();
  } catch (error) {
    status.textContent = error.message;
  }
}
document.querySelectorAll("[data-command]").forEach(
  (button) =>
    (button.onclick = () =>
      run(async () => {
        const result = await request("/command", {
          type: button.dataset.command,
          id: button.dataset.id,
        });
        status.textContent = result.message || "Done";
        button.disabled = true;
      })),
);
document.querySelector("#github")?.addEventListener("click", () =>
  run(async () => {
    const response = await request("/auth/sign-in/social", {
      provider: "github",
      callbackURL: (() => {
        const next = new URLSearchParams(location.search).get("next");
        if (!next) return location.origin + ctx.endpoint + "/access";
        const url = new URL(next, location.origin);
        return url.origin === location.origin && url.pathname.startsWith(ctx.endpoint + "/")
          ? url.href
          : location.origin + ctx.endpoint + "/access";
      })(),
      oauth_query: oauthQuery(),
    });
    if (response.url) location.assign(response.url);
  }),
);
for (const id of ["consent", "deny-consent"])
  document.querySelector("#" + id)?.addEventListener("click", () =>
    run(async () => {
      const response = await request("/auth/oauth2/consent", {
        accept: id === "consent",
        scope: [...document.querySelectorAll("[data-scope]:checked")]
          .map((el) => el.dataset.scope)
          .join(" "),
        draft: document.querySelector("#oauth-draft")?.value || undefined,
        oauth_query: oauthQuery(),
      });
      if (response.redirect_uri) location.assign(response.redirect_uri);
      else if (response.url) location.assign(response.url);
      else status.textContent = "Decision recorded.";
    }),
  );
document.querySelector("#logout")?.addEventListener("click", () =>
  run(async () => {
    await request("/logout", {});
    await fetch(ctx.endpoint + "/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    location.assign("/");
  }),
);

for (const decision of ["approve", "deny"])
  document.querySelector("#device-" + decision)?.addEventListener("click", () =>
    run(async () => {
      const userCode = document.querySelector("#device-code").value.trim();
      if (!userCode) throw new Error("Enter the code shown by your device.");
      const claim = await fetch(
        ctx.endpoint + "/auth/device?user_code=" + encodeURIComponent(userCode),
      );
      if (!claim.ok)
        throw new Error("The code is invalid, expired, or unavailable to this account.");
      await request("/auth/device/" + decision, { userCode });
      status.textContent = decision === "approve" ? "Device approved." : "Device denied.";
    }),
  );

document.querySelector("#local-oauth")?.addEventListener("click", () =>
  run(async () => {
    const response = await request("/auth/sign-in/local", { oauth_query: oauthQuery() });
    location.assign(response.redirect_uri || response.url || "/");
  }),
);
