#!/usr/bin/env bash
# Poll the token endpoint once for a given device_code (RFC 8628 step 4).
# Usage: ./device-token.sh <device_code>
# Prints the JSON response (authorization_pending, slow_down, or access_token).
set -euo pipefail
cd "$(dirname "$0")"
source ./_common.sh

device_code="${1:-}"
if [ -z "$device_code" ]; then
  echo "usage: $0 <device_code>" >&2
  exit 2
fi

c -X POST "$BASE_URL/api/auth/device/token" \
  -H 'content-type: application/json' \
  -d "{\"grant_type\":\"urn:ietf:params:oauth:grant-type:device_code\",\"device_code\":\"$device_code\",\"client_id\":\"$CLIENT_ID\"}"
echo
