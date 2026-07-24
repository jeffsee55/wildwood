#!/usr/bin/env bash
# Guided, narrated device-authorization walkthrough (RFC 8628).
#
# Same flow as device-login.sh, but paused and explained one step at a time so
# you can actually watch how it works: what each request sends, what comes back,
# and why the next step needs it. Every HTTP call is printed before it runs.
#
# Local-only. Start the dev server first (`pnpm dev:docs`), then run:
#
#   ./scripts/auth/device-walkthrough.sh
#
# Non-interactive (don't pause between steps):  STEP=0 ./scripts/auth/device-walkthrough.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./_common.sh

# ── presentation helpers ────────────────────────────────────────────────────
bold=$'\033[1m'; dim=$'\033[2m'; cyan=$'\033[36m'; green=$'\033[32m'; reset=$'\033[0m'
STEP="${STEP:-1}" # 1 = pause between steps, 0 = run straight through

heading() { printf "\n%s━━ %s ━━%s\n" "$bold$cyan" "$1" "$reset"; }
note()    { printf "%s%s%s\n" "$dim" "$1" "$reset"; }
pause() {
  [ "$STEP" = "1" ] || return 0
  printf "%s(press enter to run this step)%s " "$dim" "$reset"; read -r _ || true
}
# Print a curl invocation, then execute it and return its body in $LAST.
show_curl() {
  printf "%s\$ %s%s\n" "$green" "$*" "$reset"
  LAST="$("$@")"
  printf "%s%s%s\n" "$dim" "$LAST" "$reset"
}

cat <<EOF
${bold}Device Authorization Grant — RFC 8628 walkthrough${reset}
Server:    $BASE_URL
Client id: $CLIENT_ID  ${dim}(the device plugin accepts any id — no client secret)${reset}
Identity:  $DEV_EMAIL  ${dim}(dev email+password provider)${reset}

The device flow exists for inputs where typing a password is painful (CLIs, TVs,
CI). The device gets a short user_code; the human approves it from a browser that
is already signed in; the device polls until a token drops.
EOF

# ── step 1: device requests a code ──────────────────────────────────────────
heading "Step 1 — device asks for a code"
note "The 'device' (this script) hits the token server anonymously. It has no"
note "session and no secret — just its client_id. It gets back two codes:"
note "  device_code — secret, used later to poll for the token"
note "  user_code   — short, human-readable, shown to the person to approve"
pause
show_curl c -X POST "$BASE_URL/api/auth/device/code" \
  -H 'content-type: application/json' \
  -d "{\"client_id\":\"$CLIENT_ID\"}"

device_code="$(echo "$LAST" | json_field device_code)"
user_code="$(echo "$LAST" | json_field user_code)"
verify_uri="$(echo "$LAST" | json_field verification_uri)"
interval="$(echo "$LAST" | sed -n 's/.*"interval":\([0-9]*\).*/\1/p')"; interval="${interval:-5}"
if [ -z "$device_code" ] || [ -z "$user_code" ]; then
  echo "✗ failed to get device code — is the dev server running?" >&2; exit 1
fi
printf "\n  %suser_code%s  = %s%s%s   %s← what a human would type${reset}\n" "$bold" "$reset" "$bold" "$user_code" "$reset" "$dim"
printf "  %sverify_uri%s = %s\n" "$bold" "$reset" "$verify_uri"
printf "  %sinterval%s   = %ss   %s← minimum seconds between polls${reset}\n" "$bold" "$reset" "$interval" "$dim"

# ── step 2: establish the human's browser session ───────────────────────────
heading "Step 2 — the human signs in (browser session)"
note "Approval must come from an authenticated user. In real life you'd already"
note "be signed in at $verify_uri in a browser. Here we mint that session with"
note "the dev email+password provider and stash the cookie in a jar."
pause
show_curl ./signin.sh

# ── step 3: bind the user_code to that session (the 'verify' GET) ────────────
heading "Step 3 — human opens the verify page (binds code → user)"
note "Visiting /device?user_code=... is what the browser does when the human"
note "lands on the verification page. With the session cookie attached, it binds"
note "the pending user_code to this specific signed-in user."
pause
show_curl c -b "$COOKIE_JAR" "$BASE_URL/api/auth/device?user_code=$user_code" -H "origin: $BASE_URL"
if ! echo "$LAST" | grep -q '"status"'; then
  note "session looked stale — re-signing in and retrying the bind…"
  ./signin.sh >/dev/null
  show_curl c -b "$COOKIE_JAR" "$BASE_URL/api/auth/device?user_code=$user_code" -H "origin: $BASE_URL"
fi

# ── step 4: human approves ──────────────────────────────────────────────────
heading "Step 4 — human clicks Approve"
note "This is the consent click. The session cookie proves who is approving; the"
note "userCode says which pending device request they're granting."
pause
show_curl c -b "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/device/approve" \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"userCode\":\"$user_code\"}"

# ── step 5: device polls for the token ──────────────────────────────────────
heading "Step 5 — device polls for its token"
note "Back on the device side. It has no cookie — only the device_code from step 1."
note "Before approval this returns authorization_pending; poll too fast and you get"
note "slow_down. Once the human approved in step 4, the next poll returns the token."
pause
for attempt in 1 2 3 4 5 6; do
  printf "%s  poll #%s (waiting %ss first)…%s\n" "$dim" "$attempt" "$interval" "$reset"
  sleep "$interval"
  show_curl c -X POST "$BASE_URL/api/auth/device/token" \
    -H 'content-type: application/json' \
    -d "{\"grant_type\":\"urn:ietf:params:oauth:grant-type:device_code\",\"device_code\":\"$device_code\",\"client_id\":\"$CLIENT_ID\"}"

  if echo "$LAST" | grep -q '"access_token"'; then
    access_token="$(echo "$LAST" | json_field access_token)"
    heading "Done — access token issued"
    note "The device now holds a bearer token and never saw the user's password."
    printf "  %saccess_token%s = %s…\n" "$bold" "$reset" "${access_token:0:24}"
    printf "\nUse it: %sAuthorization: Bearer <token>%s against the API.\n" "$bold" "$reset"
    exit 0
  fi
  err="$(echo "$LAST" | json_field error)"
  if [ "$err" = "authorization_pending" ] || [ "$err" = "slow_down" ]; then
    note "  → $err (expected; keep polling)"
    [ "$err" = "slow_down" ] && interval=$((interval + 2))
    continue
  fi
  echo "✗ unexpected token error: $LAST" >&2; exit 1
done

echo "✗ timed out waiting for token" >&2
exit 1
