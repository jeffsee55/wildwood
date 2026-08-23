#!/usr/bin/env bash
# Shared config + helpers for the local auth test scripts.
#
# These drive the CMS route's better-auth endpoints against the local dev server
# on localhost. Local-only: they use the email+password provider, which the route
# enables only when NODE_ENV !== "production". Override any value via env:
#
#   BASE_URL=http://localhost:3000 DEV_EMAIL=user@wildwood.com ./device-login.sh
set -euo pipefail

# Origin used by the default docs development server.
BASE_URL="${BASE_URL:-http://localhost:3000}"

# Hardcoded local dev credentials. These mirror the library-served dev sign-in
# page (packages/wildwood/src/nextjs/handlers/device-auth-router.ts): three fixed
# identities sharing one non-secret dev password. Only the owner is granted
# access automatically. Override DEV_EMAIL to exercise an ungranted identity.
DEV_EMAIL="${DEV_EMAIL:-owner@wildwood.com}"
DEV_PASSWORD="${DEV_PASSWORD:-wildwood-dev-password}"
DEV_NAME="${DEV_NAME:-Wildwood Owner}"

# Device client id. The device plugin accepts any client_id (no validateClient),
# so this is just an identifier for the polling client.
CLIENT_ID="${CLIENT_ID:-wildwood-cli}"

# Cookie jar holding the signed-in session, shared across scripts.
COOKIE_JAR="${COOKIE_JAR:-${TMPDIR:-/tmp}/wildwood-dev-cookies.txt}"

# curl wrapper shared by the scripts.
c() { curl -sS "$@"; }

# Extract a top-level string field from a JSON blob without needing jq.
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
