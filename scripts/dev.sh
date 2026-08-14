#!/usr/bin/env bash
# Run the Worker against the LOCAL Supabase stack.
#
# wrangler.toml carries empty [vars] on purpose (they are per-environment),
# so `wrangler dev` on its own serves an app that cannot sign anyone in.
# This bridges the running stack's URL and ANON key in — and NOTHING else.
# The service-role key is deliberately not passed: no request path in this
# app may hold it, and the surest way to keep that true is for the binding
# never to exist (see src/db.ts).
#
# Usage: npm run dev  [-- --port 8791]
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"

exec "$dir/stack-env.sh" bash -c '
  exec npx wrangler dev \
    --var SUPABASE_URL:"$SUPABASE_URL" \
    --var SUPABASE_ANON_KEY:"$SUPABASE_ANON_KEY" \
    --var APP_BUILD_ID:dev "$@"
' -- "$@"
