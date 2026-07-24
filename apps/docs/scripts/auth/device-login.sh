#!/usr/bin/env bash
# Full device-authorization flow (RFC 8628), end to end, like a `wildwood login`
# CLI would drive it:
#
#   1. request a device code + user code
#   2. ensure a signed-in session (auto sign-in as the dev user)
#   3. approve the user code with that session
#   4. poll for the access token, respecting the server's interval
#
# Local-only: relies on the email+password dev sign-in. Run the dev server first
# (`pnpm dev:docs`), then: ./scripts/auth/device-login.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./_common.sh

echo "→ requesting device code from $BASE_URL"
code_resp="$(c -X POST "$BASE_URL/api/auth/device/code" \
  -H 'content-type: application/json' \
  -d "{\"client_id\":\"$CLIENT_ID\"}")"

device_code="$(echo "$code_resp" | json_field device_code)"
user_code="$(echo "$code_resp" | json_field user_code)"
verify_uri="$(echo "$code_resp" | json_field verification_uri)"
interval="$(echo "$code_resp" | sed -n 's/.*"interval":\([0-9]*\).*/\1/p')"
interval="${interval:-5}"

if [ -z "$device_code" ] || [ -z "$user_code" ]; then
  echo "✗ failed to get device code: $code_resp" >&2
  exit 1
fi
echo "  user_code:  $user_code"
echo "  verify_uri: $verify_uri"

# Ensure we have a session to approve with.
if [ ! -f "$COOKIE_JAR" ]; then
  echo "→ no session yet, signing in…"
  ./signin.sh
fi

# Claim the pending code with our session first (RFC 8628 verify step). This is
# what the browser's GET /device?user_code=… does: it binds the device code to
# the signed-in user, which the approve endpoint requires. Re-sign-in and retry
# once if the session was stale/expired.
claim() {
  c -b "$COOKIE_JAR" "$BASE_URL/api/auth/device?user_code=$user_code" -H "origin: $BASE_URL"
}
echo "→ claiming user_code $user_code with session"
claim_resp="$(claim)"
if ! echo "$claim_resp" | grep -q '"status"'; then
  echo "  claim needs a fresh session, re-signing in…"
  ./signin.sh
  claim_resp="$(claim)"
fi
echo "  claim response: $claim_resp"

echo "→ approving user_code $user_code"
approve_resp="$(c -b "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/device/approve" \
  -H 'content-type: application/json' \
  -H "origin: $BASE_URL" \
  -d "{\"userCode\":\"$user_code\"}")"
echo "  approve response: $approve_resp"

echo "→ polling for token (interval ${interval}s)…"
for attempt in 1 2 3 4 5 6; do
  sleep "$interval"
  tok_resp="$(c -X POST "$BASE_URL/api/auth/device/token" \
    -H 'content-type: application/json' \
    -d "{\"grant_type\":\"urn:ietf:params:oauth:grant-type:device_code\",\"device_code\":\"$device_code\",\"client_id\":\"$CLIENT_ID\"}")"

  if echo "$tok_resp" | grep -q '"access_token"'; then
    echo "✓ got token:"
    echo "$tok_resp"
    exit 0
  fi
  if echo "$tok_resp" | grep -q 'authorization_pending\|slow_down'; then
    echo "  attempt $attempt: $(echo "$tok_resp" | json_field error) — retrying"
    continue
  fi
  echo "✗ token error: $tok_resp" >&2
  exit 1
done

echo "✗ timed out waiting for token" >&2
exit 1
