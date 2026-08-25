#!/usr/bin/env bash
# THE ISOLATION PROOF — the non-waivable gate (track law 1) — followed by
# THE ROUTE PROOF, which re-asserts the same law at the rendered page, THE
# WRITE PROOF, which walks the day-in-the-life scenario through the real
# Worker and pins the capability table, and THE RESET PROOF, which proves
# the reset job end to end (freeze honored, receipts journaled, baseline
# restored) and finishes with the reset→login→walk smoke.
#
# All assume a freshly seeded stack: the isolation proof asserts EXACT row
# counts, and its own lifecycle exercises (role change + revert, reopen +
# re-close) add audit rows, so re-runs want a reseed first. The
# one-command path is:
#
#   npm run db:rebuild     # supabase db reset -> seed -> these proofs
#
# The suites run as SEPARATE vitest invocations, in this order, on
# purpose: the isolation proof must meet the seeded baseline before
# anything else has touched it. The route proof is read-only and leaves
# that baseline as it found it. The write proof MUTATES — it measures its
# own baseline rather than assuming one. The reset proof WIPES AND
# RESEEDS — it goes dead last, and leaves the stack at the fresh baseline.
#
# Works identically on a console and in CI: `supabase start` first.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"

"$dir/stack-env.sh" npx vitest run test/isolation.test.ts "$@"
"$dir/stack-env.sh" npx vitest run test/routes.test.ts "$@"
"$dir/stack-env.sh" npx vitest run test/writes.test.ts "$@"
exec "$dir/stack-env.sh" npx vitest run test/reset.test.ts "$@"
