// The reset-to-baseline job (GD-0035: nightly 04:00 ET + on-demand
// dispatch + demo-freeze switch) — THE JOB PLANE, deliberately separate
// from the request path.
//
// The stratum law says scheduled work for a Workers-class app runs as a
// Workers cron, never GitHub Actions — so this module DOES build a
// service-role client, from a binding (`SUPABASE_SERVICE_ROLE_KEY`, a
// Workers secret provisioned at CRMDEMO-EPIC1-07) that the request path
// cannot see: the app's own Env (src/env.ts) has no such field, the app
// router (src/index.tsx) never imports this module, and
// test/source.test.ts greps both facts. The 03 law — no service-role
// client in a REQUEST PATH — still holds; this is the plane it was
// keeping the key for.
//
// Every run journals a job_runs receipt, including the honest no-ops:
// a frozen skip is a receipt that says "skipped: frozen", and an
// unprovisioned invocation logs loudly (it cannot journal — the journal
// needs the very credentials that are missing).

import type { Env } from "../env";
import { restoreBaseline, serviceClient, type TenantSummary } from "../seed/runner";

/**
 * The job plane's bindings: the app's Env plus the two secrets the sysop
 * provisions at go-live (07). Both optional BY TYPE because the pipeline
 * must prove itself without them — an absent binding is an inert surface,
 * never a crash.
 */
export interface JobEnv extends Env {
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESET_DISPATCH_TOKEN?: string;
}

export type ResetTrigger = "cron" | "dispatch";

export type ResetOutcome =
  | { ok: true; skipped: "frozen" }
  | { ok: true; skipped?: undefined; tenants: TenantSummary[] }
  | { ok: false; error: string };

const FREEZE_KEY = "demo_freeze";

const targetOf = (env: JobEnv) => ({
  url: env.SUPABASE_URL,
  anonKey: env.SUPABASE_ANON_KEY,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  log: (line: string) => console.log(`reset: ${line}`),
});

/** The demo-freeze switch, read from its service-plane home. */
export async function isFrozen(env: JobEnv): Promise<boolean> {
  const service = serviceClient(targetOf(env));
  const { data, error } = await service
    .from("app_settings")
    .select("value")
    .eq("key", FREEZE_KEY)
    .maybeSingle();
  if (error) throw new Error(`read ${FREEZE_KEY}: ${error.message}`);
  return data?.value === true;
}

const journal = async (
  env: JobEnv,
  job: string,
  startedAt: string,
  ok: boolean,
  detail: Record<string, unknown>,
): Promise<void> => {
  const service = serviceClient(targetOf(env));
  const { error } = await service.from("job_runs").insert({
    job,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok,
    detail,
  });
  if (error) {
    // the receipt is the last thing that can fail; say so where Workers
    // Logs will keep it, because there is nowhere else left to write
    console.error(`${job}: receipt failed: ${error.message}`);
  }
};

/**
 * Restore data AND demo-account state to the scenario baseline — or
 * honor the freeze and journal the no-op. Both paths leave a receipt.
 */
export async function runReset(env: JobEnv, trigger: ResetTrigger): Promise<ResetOutcome> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    // Unprovisioned (pre-07, or a local stack without the bridge): loud,
    // inert, and unjournalable — the journal needs the missing credential.
    console.error(`reset (${trigger}): SUPABASE_SERVICE_ROLE_KEY is not provisioned — no-op`);
    return { ok: false, error: "service credentials not provisioned" };
  }

  const startedAt = new Date().toISOString();
  try {
    if (await isFrozen(env)) {
      await journal(env, "reset", startedAt, true, { trigger, skipped: "frozen" });
      console.log(`reset (${trigger}): skipped — demo freeze is on`);
      return { ok: true, skipped: "frozen" };
    }

    const tenants = await restoreBaseline(targetOf(env));
    await journal(env, "reset", startedAt, true, { trigger, tenants });
    console.log(`reset (${trigger}): scenario baseline restored`);
    return { ok: true, tenants };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`reset (${trigger}) failed: ${message}`);
    await journal(env, "reset", startedAt, false, { trigger, error: message });
    return { ok: false, error: message };
  }
}

/**
 * Flip the demo-freeze switch. A flip is an operational act, so it leaves
 * a receipt too — a frozen demo with no note saying who froze it and when
 * would be a mystery at 04:00 ET.
 */
export type FreezeOutcome = { ok: true; frozen: boolean } | { ok: false; error: string };

export async function setFreeze(
  env: JobEnv,
  frozen: boolean,
  trigger: ResetTrigger,
): Promise<FreezeOutcome> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`freeze (${trigger}): SUPABASE_SERVICE_ROLE_KEY is not provisioned — no-op`);
    return { ok: false, error: "service credentials not provisioned" };
  }

  const startedAt = new Date().toISOString();
  try {
    const service = serviceClient(targetOf(env));
    const { error } = await service
      .from("app_settings")
      .upsert({ key: FREEZE_KEY, value: frozen, updated_at: new Date().toISOString() });
    if (error) throw new Error(`write ${FREEZE_KEY}: ${error.message}`);
    await journal(env, frozen ? "freeze" : "unfreeze", startedAt, true, { trigger });
    return { ok: true, frozen };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`freeze (${trigger}) failed: ${message}`);
    return { ok: false, error: message };
  }
}
