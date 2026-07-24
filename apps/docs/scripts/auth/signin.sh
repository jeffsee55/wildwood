#!/usr/bin/env bash
# Sign in as the local dev user, saving the session cookie to $COOKIE_JAR.
# Creates the dev user first if it doesn't exist yet. Local-only (email+password).
set -euo pipefail
cd "$(dirname "$0")"
source ./_common.sh

echo "→ signing in $DEV_EMAIL at $BASE_URL"

# Try sign-in; if it fails (user missing), sign up then retry.
resp="$(c -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/sign-in/email" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\"}")"

if ! echo "$resp" | grep -q '"user"'; then
  echo "  no existing user, creating one…"
  c -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/sign-up/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\",\"name\":\"$DEV_NAME\"}" \
    >/dev/null
  resp="$(c -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\"}")"
fi

if echo "$resp" | grep -q '"user"'; then
  echo "✓ signed in — session cookie saved to $COOKIE_JAR"
else
  echo "✗ sign-in failed: $resp" >&2
  exit 1
fi
