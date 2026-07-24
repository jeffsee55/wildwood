#!/usr/bin/env bash
# Shared config + helpers for the local auth test scripts.
#
# These drive the CMS route's better-auth endpoints against the local dev server
# (portless proxy). Local-only: they use the email+password provider, which the
# route enables only when NODE_ENV !== "production". Override any value via env:
#
#   BASE_URL=https://ww.localhost DEV_EMAIL=me@x.dev ./device-login.sh
set -euo pipefail

# Origin the app is served from in dev (portless proxy). better-auth trusts this
# for CSRF-protected endpoints; it must match `trustedOrigins` in the CMS route.
BASE_URL="${BASE_URL:-https://ww.localhost}"

# Hardcoded local dev credentials. These mirror the library-served dev sign-in
# page (packages/wildwood/src/nextjs/handlers/device-auth-router.ts): three fixed
# identities (admin/owner/contributer@wildwood.com) sharing one non-secret dev
# password. Override DEV_EMAIL to test the flow as a different identity, e.g.
#   DEV_EMAIL=owner@wildwood.com ./device-login.sh
DEV_EMAIL="${DEV_EMAIL:-admin@wildwood.com}"
DEV_PASSWORD="${DEV_PASSWORD:-wildwood-dev-password}"
DEV_NAME="${DEV_NAME:-Wildwood Admin}"

# Device client id. The device plugin accepts any client_id (no validateClient),
# so this is just an identifier for the polling client.
CLIENT_ID="${CLIENT_ID:-wildwood-cli}"

# Cookie jar holding the signed-in session, shared across scripts.
COOKIE_JAR="${COOKIE_JAR:-${TMPDIR:-/tmp}/wildwood-dev-cookies.txt}"

# curl with self-signed cert tolerance (-k) for the local https proxy.
c() { curl -sk "$@"; }

# Extract a top-level string field from a JSON blob without needing jq.
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
