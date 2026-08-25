// THE RESET PROOF (CRMDEMO-EPIC1-06) — the fourth stack-backed gate, and
// the end-to-end smoke the 06 prompt asks for once 03 has landed: reset →
// sign in → walk a scenario, all through the real Worker.
//
// It proves the reset JOB, not just the seed it composes:
//
//   * the demo-freeze switch is honored — a frozen scheduled run is an
//     honest no-op WITH A RECEIPT ("skipped: frozen"), and the data it
//     did not touch is still there to prove it;
//   * an on-demand dispatch restores data AND demo-account state to the
//     scenario baseline (defacement gone, the tampered role back);
//   * every run journals to job_runs;
//   * seed-time-relative dates mean a fresh reset always looks current;
//   * app_settings (the freeze's home) is service-plane-only, like
//     job_runs.
//
// IT MUTATES HEAVILY (a full wipe-and-reseed), so it runs LAST — after
// the write proof — and it LEAVES THE STACK AT THE FRESH BASELINE, which
// is more than it found.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { app } from "../src/index";
import worker from "../src/worker";
import type { JobEnv } from "../src/jobs/reset";
import { buildScenario, PENDING_ROLE_CHANGE, type SeedUser, type TenantPlan } from "../src/seed/scenario";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] ?? "";
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("run via scripts/run-isolation.sh (bridges the local stack env)");
}

const DISPATCH_TOKEN = "test-dispatch-token";

const jobEnv: JobEnv = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  APP_BUILD_ID: "test-crmdemo-06",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  RESET_DISPATCH_TOKEN: DISPATCH_TOKEN,
};

const appEnv = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  APP_BUILD_ID: "test-crmdemo-06",
};

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

const plan = buildScenario();
const wumpus = plan.tenants[0]!;

const userOf = (tenant: TenantPlan, key: string): SeedUser => {
  const user = tenant.users.find((u) => u.key === key);
  if (!user) throw new Error(`no seeded user ${tenant.slug}/${key}`);
  return user;
};

const dispatch = (path: string, token = DISPATCH_TOKEN) =>
  worker.fetch(
    new Request(`https://demo.local${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    jobEnv,
    ctx,
  );

const lastRun = async (job: string) => {
  const { data, error } = await service
    .from("job_runs")
    .select("job, ok, detail, started_at, finished_at")
    .eq("job", job)
    .order("id", { ascending: false })
    .limit(1);
  expect(error).toBeNull();
  return (data ?? [])[0] as
    | { job: string; ok: boolean; detail: Record<string, unknown>; finished_at: string }
    | undefined;
};

const tenantIdOf = async (slug: string): Promise<string> => {
  const { data, error } = await service.from("tenants").select("id").eq("slug", slug).single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
};

/** Signs in THROUGH THE APP's own login route and returns its cookie header. */
async function signIn(user: SeedUser): Promise<string> {
  const res = await app.request(
    "/login",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: user.email, password: user.password }).toString(),
    },
    appEnv,
  );
  expect(res.status, `login ${user.email} -> ${res.status}`).toBe(303);
  const pairs = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean);
  return pairs.join("; ");
}

// state shared across the ordered steps below
let wumpusId = "";
let samUserId = "";
const SENTINEL_ORG = "Sentinel Defacement Ltd (should not survive a reset)";

beforeAll(async () => {
  wumpusId = await tenantIdOf(wumpus.slug);
  const sam = userOf(wumpus, PENDING_ROLE_CHANGE.userKey);
  const { data, error } = await service
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", wumpusId)
    .eq("display_name", sam.displayName)
    .single();
  expect(error).toBeNull();
  samUserId = (data as { user_id: string }).user_id;
});

describe("app_settings is service-plane-only, like job_runs", () => {
  it("anon reads zero rows, never a permission error", async () => {
    const { data, error } = await anon.from("app_settings").select("key");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a signed-in user reads zero rows too", async () => {
    const rep = userOf(wumpus, "riley");
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email: rep.email,
      password: rep.password,
    });
    expect(signInError).toBeNull();
    const { data, error } = await client.from("app_settings").select("key");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { error: writeError } = await client
      .from("app_settings")
      .update({ value: true })
      .eq("key", "demo_freeze");
    expect(writeError, "an API principal must not be able to flip the freeze").not.toBeNull();
  });

  it("the service plane sees the switch, born open", async () => {
    const { data, error } = await service
      .from("app_settings")
      .select("value")
      .eq("key", "demo_freeze")
      .single();
    expect(error).toBeNull();
    expect((data as { value: unknown }).value).toBe(false);
  });
});

describe("the reset job (run → receipt → data restored → freeze honored)", () => {
  it("step 1: the world gets dirtied — defacement and a tampered role", async () => {
    // a rep defaces their (synthetic) tenant through the real app
    const rep = userOf(wumpus, "riley");
    const cookie = await signIn(rep);
    const res = await app.request(
      "/organizations",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          name: SENTINEL_ORG,
          domain: "",
          industry: "",
          city: "",
        }).toString(),
      },
      appEnv,
    );
    expect(res.status).toBe(303);

    // account state drifts too (service plane stands in for an admin act)
    const { error } = await service
      .from("memberships")
      .update({ role: PENDING_ROLE_CHANGE.to })
      .eq("tenant_id", wumpusId)
      .eq("user_id", samUserId);
    expect(error).toBeNull();
  });

  it("step 2: the sysop freezes the demo (dispatch, with a receipt)", async () => {
    const res = await dispatch("/jobs/freeze");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, frozen: true });
    const receipt = await lastRun("freeze");
    expect(receipt).toMatchObject({ ok: true, detail: { trigger: "dispatch" } });
  });

  it("step 3: the nightly cron fires into the freeze — an honest no-op with a receipt", async () => {
    await worker.scheduled(
      { cron: "0 8 * * *", scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      jobEnv,
    );
    const receipt = await lastRun("reset");
    expect(receipt).toMatchObject({
      ok: true,
      detail: { trigger: "cron", skipped: "frozen" },
    });

    // and it really did nothing: the defacement is untouched
    const { data } = await service
      .from("organizations")
      .select("id")
      .eq("name", SENTINEL_ORG);
    expect(data?.length).toBe(1);
  });

  it("step 4: unfreeze, then an on-demand reset restores the baseline", { timeout: 300_000 }, async () => {
    const thaw = await dispatch("/jobs/unfreeze");
    expect(thaw.status).toBe(200);
    expect(await thaw.json()).toMatchObject({ ok: true, frozen: false });

    const res = await dispatch("/jobs/reset");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenants: { slug: string }[] };
    expect(body.ok).toBe(true);
    expect(body.tenants.map((t) => t.slug)).toEqual(plan.tenants.map((t) => t.slug));

    const receipt = await lastRun("reset");
    expect(receipt).toMatchObject({ ok: true, detail: { trigger: "dispatch" } });
    expect(receipt?.detail["skipped"]).toBeUndefined();
  });

  it("step 5: the defacement is gone and every tenant is back at its exact baseline", async () => {
    const { data } = await service.from("organizations").select("id").eq("name", SENTINEL_ORG);
    expect(data).toEqual([]);

    for (const tenant of plan.tenants) {
      const tenantId = await tenantIdOf(tenant.slug);
      for (const [table, expected] of [
        ["organizations", tenant.expected.organizations],
        ["people", tenant.expected.people],
        ["deals", tenant.expected.deals],
        ["activities", tenant.expected.activities],
        ["memberships", tenant.expected.memberships],
        ["audit_log", tenant.expected.auditRows],
      ] as const) {
        const { count, error } = await service
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("tenant_id", tenantId);
        expect(error, `${tenant.slug}/${table}`).toBeNull();
        expect(count, `${tenant.slug}/${table}`).toBe(expected);
      }
    }
  });

  it("step 6: demo-account state came back too — the tampered role is a rep again", async () => {
    const { data, error } = await service
      .from("memberships")
      .select("role, user_id")
      .eq("tenant_id", wumpusId)
      .eq("display_name", userOf(wumpus, PENDING_ROLE_CHANGE.userKey).displayName)
      .single();
    expect(error).toBeNull();
    expect((data as { role: string }).role).toBe(PENDING_ROLE_CHANGE.from);

    // and a deactivated account is still refused at the door
    const deactivated = wumpus.users.find((u) => !u.active);
    expect(deactivated, "the scenario seeds a deactivated wumpus user").toBeDefined();
    const res = await app.request(
      "/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: deactivated!.email,
          password: deactivated!.password,
        }).toString(),
      },
      appEnv,
    );
    expect(res.status).toBe(401);
  });

  it("step 7: a fresh reset always looks current (seed-time-relative dates)", async () => {
    const { data, error } = await service
      .from("activities")
      .select("occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(1);
    expect(error).toBeNull();
    const newest = new Date((data as { occurred_at: string }[])[0]!.occurred_at).getTime();
    const ageDays = (Date.now() - newest) / 86_400_000;
    expect(ageDays, "the newest seeded activity is stale — the reset is not current").toBeLessThan(4);
  });

  it("step 8: the smoke — sign in and walk a scenario on the freshly reset world", async () => {
    const rep = userOf(wumpus, "riley");
    const cookie = await signIn(rep);

    const overview = await app.request("/", { headers: { cookie } }, appEnv);
    expect(overview.status).toBe(200);
    expect(await overview.text()).toContain(wumpus.name);

    const deals = await app.request("/deals", { headers: { cookie } }, appEnv);
    expect(deals.status).toBe(200);
    const dealsHtml = await deals.text();
    const someDeal = wumpus.deals[0]!;
    expect(dealsHtml).toContain(someDeal.name);

    // the front door still publishes the login that just worked
    const demo = await app.request("/demo", {}, appEnv);
    expect(demo.status).toBe(200);
    expect(await demo.text()).toContain(rep.email);
  });
});
