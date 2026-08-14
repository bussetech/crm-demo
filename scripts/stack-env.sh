#!/usr/bin/env bash
# Bridge the local Supabase stack's URL + keys into the environment, then
# exec the given command. The studio's env-bridge idiom (saas-stratum.md):
# `supabase status -o env` names have drifted across CLI versions, and its
# output is NOT pure env — never `eval` it; extract fields explicitly.
# Pre-set SUPABASE_* variables win (that is how CI / hosted targets work).
set -euo pipefail

if ! command -v supabase >/dev/null; then
  echo "error: supabase CLI not installed (https://supabase.com/docs/guides/cli)" >&2
  exit 1
fi

status="$(supabase status -o env 2>/dev/null)" || {
  echo "error: local stack not running — run 'supabase start' first" >&2
  exit 1
}

get() { echo "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" | head -1; }

export SUPABASE_URL="${SUPABASE_URL:-$(get API_URL)}"
export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-$(get ANON_KEY)}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-$(get SERVICE_ROLE_KEY)}"

if [ -z "$SUPABASE_ANON_KEY" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "error: could not resolve keys from 'supabase status -o env'" >&2
  exit 1
fi

exec "$@"
