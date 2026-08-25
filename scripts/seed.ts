// The scenario seed runner — the CLI door onto the seed ENGINE
// (src/seed/runner.ts, shared with the Worker's reset job). Wipes and
// rebuilds the scenario baseline, then journals its own job_runs receipt.
//
// Run via the env bridge (local stack keys): npm run seed
// Against the hosted stack (go-live, CRMDEMO-EPIC1-07): set SUPABASE_URL /
// SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY explicitly.

import { restoreBaseline, serviceClient } from "../src/seed/runner";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    "error: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY required (run via scripts/stack-env.sh)",
  );
  process.exit(1);
}

const target = {
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  serviceRoleKey: SERVICE_ROLE_KEY,
  log: console.log,
};

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString();
  const summaries = await restoreBaseline(target);

  // the honest receipt (stratum law: every job leaves one)
  const { error } = await serviceClient(target)
    .from("job_runs")
    .insert({
      job: "seed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: true,
      detail: { tenants: summaries },
    });
  if (error) throw new Error(`job_runs receipt: ${error.message}`);

  console.log("seed complete — scenario baseline rebuilt");
};

main().catch((error) => {
  console.error("seed failed:", error.message ?? error);
  process.exitCode = 1;
});
