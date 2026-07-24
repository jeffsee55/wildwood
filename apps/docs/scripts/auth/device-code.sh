#!/usr/bin/env bash
# Request a device code + user code (RFC 8628 step 1). Prints the full JSON and,
# on the last two lines, the device_code and user_code for easy copy/paste or
# scripting:  DC=$(./device-code.sh | sed -n 's/^device_code=//p')
set -euo pipefail
cd "$(dirname "$0")"
source ./_common.sh

resp="$(c -X POST "$BASE_URL/api/auth/device/code" \
  -H 'content-type: application/json' \
  -d "{\"client_id\":\"$CLIENT_ID\"}")"
echo "$resp"
echo "device_code=$(echo "$resp" | json_field device_code)"
echo "user_code=$(echo "$resp" | json_field user_code)"
