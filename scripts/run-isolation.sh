#!/usr/bin/env bash
# THE ISOLATION PROOF — the non-waivable gate (track law 1). Assumes a
# freshly seeded stack: the proof asserts EXACT row counts, and its own
# lifecycle exercises (role change + revert, reopen + re-close) add audit
# rows, so re-runs want a reseed first. The one-command path is:
#
#   npm run db:rebuild     # supabase db reset -> seed -> this proof
#
# Works identically on a console and in CI: `supabase start` first.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
exec "$dir/stack-env.sh" npx vitest run test/isolation.test.ts "$@"
