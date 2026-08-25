// The Worker entry point: TWO PLANES, one deployable.
//
//  * THE APP PLANE — every user-facing route, delegated untouched to
//    src/index.tsx. Its binding surface (src/env.ts) has no field a
//    service-role client could be built from; that stays true here.
//  * THE JOB PLANE — the reset-to-baseline job (GD-0035), reachable two
//    ways: the nightly cron (the `scheduled` handler below; the trigger is
//    declared in wrangler.toml) and the sysop's on-demand dispatch routes
//    under /jobs/*, which exist only once RESET_DISPATCH_TOKEN is
//    provisioned (CRMDEMO-EPIC1-07) — before that they answer 404, so the
//    unprovisioned pipeline proves itself with no secrets anywhere.
//
// The split is structural, not stylistic: test/source.test.ts asserts the
// app router never imports the job plane and that only this file and
// src/jobs/** may name the service-role binding.
//
// Dispatch surface (all POST, bearer-token authenticated):
//   /jobs/reset     — restore the scenario baseline now (before a demo)
//   /jobs/freeze    — demo-freeze ON: scheduled resets skip, with receipts
//   /jobs/unfreeze  — demo-freeze OFF
//
// Same-origin/CSRF middleware does not apply here (no cookies, no forms):
// the bearer token is the whole authorization, compared digest-to-digest
// so a mismatch costs constant time.

import app from "./index";
import { runReset, setFreeze, type JobEnv, type ResetTrigger } from "./jobs/reset";

export type { JobEnv };

/** The job plane's surface — exported so tests can name it. */
export const JOB_ROUTES = ["/jobs/reset", "/jobs/freeze", "/jobs/unfreeze"] as const;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Constant-time-enough bearer check: compare SHA-256 digests, not strings. */
async function tokenMatches(header: string | null, expected: string): Promise<boolean> {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function handleJobs(request: Request, env: JobEnv): Promise<Response> {
  const path = new URL(request.url).pathname;

  // No token binding = no dispatch surface. 404, not 401: an
  // unprovisioned door does not exist, and does not advertise itself.
  if (!env.RESET_DISPATCH_TOKEN) return json({ error: "not found" }, 404);
  if (!(JOB_ROUTES as readonly string[]).includes(path)) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!(await tokenMatches(request.headers.get("authorization"), env.RESET_DISPATCH_TOKEN))) {
    return json({ error: "forbidden" }, 403);
  }

  const trigger: ResetTrigger = "dispatch";
  if (path === "/jobs/reset") {
    const outcome = await runReset(env, trigger);
    if (outcome.ok) return json(outcome, 200);
    return json(outcome, outcome.error.includes("not provisioned") ? 503 : 500);
  }
  const outcome = await setFreeze(env, path === "/jobs/freeze", trigger);
  if (outcome.ok) return json(outcome, 200);
  return json(outcome, outcome.error.includes("not provisioned") ? 503 : 500);
}

export default {
  fetch(request: Request, env: JobEnv, ctx: ExecutionContext): Response | Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/jobs/")) {
      return handleJobs(request, env);
    }
    return app.fetch(request, env, ctx);
  },

  /**
   * The nightly reset (GD-0035; cron in wrangler.toml). Awaited, not
   * waitUntil'ed: a failed run must fail the scheduled invocation so the
   * platform's cron metrics see it, and the job_runs receipt says why.
   */
  async scheduled(controller: ScheduledController, env: JobEnv): Promise<void> {
    console.log(`scheduled reset firing (cron: ${controller.cron})`);
    await runReset(env, "cron");
  },
};
