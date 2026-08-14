// THE ISOLATION PROOF — the non-waivable gate (track law 1, stratum law).
// Signs in as EVERY role in EVERY tenant plus anonymous against the local
// stack and asserts EXACT row counts from the scenario plan (the single
// source of truth): cross-tenant = zero rows (never an error), anonymous
// = nothing anywhere, deactivated = a stranger everywhere, write refusals
// verified (wrong role, wrong tenant, deactivated, grant layer), demo
// credentials work, the service plane confined.
//
// Requires a FRESHLY SEEDED stack (npm run db:rebuild) — the lifecycle
// sections at the end (audited role change, audited reopen) add audit
// rows by design, so exact counts only hold on the first run after a
// seed. That is not a weakness of the proof; it is what "every privileged
// act writes an audit row" looks like.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { buildScenario, type TenantPlan } from "../src/seed/scenario";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("run via scripts/run-isolation.sh (bridges the local stack env)");
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

const TENANT_TABLES = [
  "tenants",
  "memberships",
  "organizations",
  "people",
  "deals",
  "activities",
  "audit_log",
] as const;

const ALL_TABLES = [...TENANT_TABLES, "job_runs"] as const;

const plan = buildScenario();

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOptions);
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions);

// signed-in client per user, keyed `${tenantSlug}/${userKey}`
const clients = new Map<string, SupabaseClient>();
const tenantIds = new Map<string, string>();
const userIds = new Map<string, string>(); // `${tenantSlug}/${userKey}` -> auth user id

const clientOf = (tenant: TenantPlan, key: string): SupabaseClient => {
  const client = clients.get(`${tenant.slug}/${key}`);
  if (!client) throw new Error(`no client for ${tenant.slug}/${key}`);
  return client;
};

/** exact count via RLS — asserts the read SUCCEEDS (zero rows, no error) */
const countRows = async (client: SupabaseClient, table: string): Promise<number> => {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true });
  expect(error, `count ${table}: ${error?.message}`).toBeNull();
  return count ?? 0;
};

const wumpus = plan.tenants[0]!;
const bandersnatch = plan.tenants[1]!;

const dealIdByName = async (name: string): Promise<string> => {
  const { data, error } = await service.from("deals").select("id").eq("name", name);
  expect(error).toBeNull();
  expect(data, `deal not found: ${name}`).toHaveLength(1);
  return data![0]!.id as string;
};

beforeAll(async () => {
  // tenant ids
  for (const tenant of plan.tenants) {
    const { data, error } = await service
      .from("tenants")
      .select("id")
      .eq("slug", tenant.slug)
      .single();
    if (error || !data) throw new Error(`tenant ${tenant.slug} not seeded — npm run db:rebuild first`);
    tenantIds.set(tenant.slug, data.id as string);
  }
  // DEMO CREDENTIALS WORK: every seeded user (deactivated included — their
  // ACCOUNT is valid; their MEMBERSHIP is what deactivation kills)
  for (const tenant of plan.tenants) {
    for (const user of tenant.users) {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions);
      const { data, error } = await client.auth.signInWithPassword({
        email: user.email,
        password: user.password,
      });
      if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`);
      clients.set(`${tenant.slug}/${user.key}`, client);
      userIds.set(`${tenant.slug}/${user.key}`, data.user!.id);
    }
  }
}, 120_000);

describe("exact counts: every role x every tenant sees exactly its tenant", () => {
  for (const tenant of plan.tenants) {
    for (const user of tenant.users.filter((u) => u.active)) {
      it(`${tenant.slug}/${user.key} (${user.role})`, async () => {
        const client = clientOf(tenant, user.key);
        const e = tenant.expected;
        expect(await countRows(client, "tenants")).toBe(1);
        expect(await countRows(client, "memberships")).toBe(e.memberships);
        expect(await countRows(client, "organizations")).toBe(e.organizations);
        expect(await countRows(client, "people")).toBe(e.people);
        expect(await countRows(client, "deals")).toBe(e.deals);
        expect(await countRows(client, "activities")).toBe(e.activities);
        expect(await countRows(client, "audit_log")).toBe(
          user.role === "admin" ? e.auditRows : 0,
        );
        expect(await countRows(client, "job_runs")).toBe(0); // service plane only
      }, 15_000);
    }
  }
});

describe("cross-tenant = zero rows, never an error", () => {
  for (const tenant of plan.tenants) {
    for (const user of tenant.users.filter((u) => u.active)) {
      it(`${tenant.slug}/${user.key} sees nothing of the other tenants`, async () => {
        const client = clientOf(tenant, user.key);
        for (const other of plan.tenants.filter((t) => t.slug !== tenant.slug)) {
          const otherId = tenantIds.get(other.slug)!;
          for (const table of ["organizations", "people", "deals", "activities"]) {
            const { data, error } = await client
              .from(table)
              .select("id")
              .eq("tenant_id", otherId);
            expect(error, `${table}: ${error?.message}`).toBeNull();
            expect(data).toHaveLength(0);
          }
        }
      }, 15_000);
    }
  }
});

describe("anonymous = nothing anywhere (zero rows, not errors)", () => {
  for (const table of ALL_TABLES) {
    it(`anon sees zero ${table}`, async () => {
      expect(await countRows(anon, table)).toBe(0);
    });
  }
});

describe("deactivated = a stranger everywhere", () => {
  for (const tenant of plan.tenants) {
    for (const user of tenant.users.filter((u) => !u.active)) {
      it(`${tenant.slug}/${user.key} signs in but sees nothing`, async () => {
        const client = clientOf(tenant, user.key);
        for (const table of ALL_TABLES) {
          expect(await countRows(client, table)).toBe(0);
        }
      }, 15_000);

      it(`${tenant.slug}/${user.key} cannot write`, async () => {
        const client = clientOf(tenant, user.key);
        const { error } = await client.from("activities").insert({
          tenant_id: tenantIds.get(tenant.slug),
          type: "note",
          subject: "should never land",
          occurred_at: new Date().toISOString(),
          org_id: null,
          person_id: null,
          deal_id: null,
          created_by: userIds.get(`${tenant.slug}/${user.key}`),
        });
        expect(error).not.toBeNull();
      });
    }
  }
});

describe("the manager view is real data, honestly shaped", () => {
  it("wumpus deals match the planned stage distribution, closes recent", async () => {
    const morgan = clientOf(wumpus, "morgan");
    const { data, error } = await morgan.from("deals").select("stage, closed_at");
    expect(error).toBeNull();
    const byStage: Record<string, number> = {};
    for (const row of data!) byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
    expect(byStage).toEqual(wumpus.expected.dealsByStage);
    for (const row of data!) {
      const terminal = row.stage === "won" || row.stage === "lost";
      expect(row.closed_at !== null).toBe(terminal);
      if (terminal) {
        expect(Date.now() - Date.parse(row.closed_at)).toBeLessThan(48 * 3_600_000);
      }
    }
  });
});

describe("write refusals", () => {
  it("anon cannot insert anywhere (grant layer, loud)", async () => {
    const { error } = await anon
      .from("organizations")
      .insert({ tenant_id: tenantIds.get(wumpus.slug), name: "Sneaky Org" });
    expect(error).not.toBeNull();
  });

  it("a member cannot insert into another tenant (RLS with-check)", async () => {
    const riley = clientOf(wumpus, "riley");
    const { error } = await riley.from("organizations").insert({
      tenant_id: tenantIds.get(bandersnatch.slug),
      name: "Wrong World Org",
      created_by: userIds.get(`${wumpus.slug}/riley`),
    });
    expect(error).not.toBeNull();
  });

  it("a rep updating another member's deal affects zero rows", async () => {
    const sam = clientOf(wumpus, "sam");
    const morganLead = wumpus.deals.findIndex(
      (d) => d.ownerKey === "morgan" && d.targetStage === "lead",
    );
    const dealId = await dealIdByName(wumpus.deals[morganLead]!.name);
    const { data, error } = await sam
      .from("deals")
      .update({ stage: "qualified" })
      .eq("id", dealId)
      .select("id");
    expect(error).toBeNull(); // silent, like a read denial
    expect(data).toHaveLength(0);
    const { data: after } = await service.from("deals").select("stage").eq("id", dealId);
    expect(after![0]!.stage).toBe("lead");
  });

  it("a rep cannot hand their own deal to someone else", async () => {
    const sam = clientOf(wumpus, "sam");
    const samLead = wumpus.deals.find(
      (d) => d.ownerKey === "sam" && d.targetStage === "lead",
    )!;
    const dealId = await dealIdByName(samLead.name);
    const { error } = await sam
      .from("deals")
      .update({ owner_id: userIds.get(`${wumpus.slug}/riley`) })
      .eq("id", dealId);
    expect(error).not.toBeNull();
  });

  it("append-only surfaces refuse UPDATE at the grant layer", async () => {
    const riley = clientOf(wumpus, "riley");
    const { error: activityError } = await riley
      .from("activities")
      .update({ subject: "rewritten history" })
      .eq("tenant_id", tenantIds.get(wumpus.slug));
    expect(activityError).not.toBeNull();

    const ada = clientOf(wumpus, "ada");
    const { error: membershipError } = await ada
      .from("memberships")
      .update({ role: "admin" })
      .eq("tenant_id", tenantIds.get(wumpus.slug));
    expect(membershipError).not.toBeNull(); // RPCs are the only path

    const { error: auditError } = await ada.from("audit_log").insert({
      tenant_id: tenantIds.get(wumpus.slug),
      action: "demo.reset",
      entity_type: "tenant",
    });
    expect(auditError).not.toBeNull();
  });

  it("a rep cannot administer memberships (wrong role, loud)", async () => {
    const riley = clientOf(wumpus, "riley");
    const { error } = await riley.rpc("membership_set_role", {
      p_tenant_id: tenantIds.get(wumpus.slug),
      p_user_id: userIds.get(`${wumpus.slug}/sam`),
      p_role: "manager",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("requires role admin");
  });

  it("an admin's power stops at their tenant boundary", async () => {
    const ada = clientOf(wumpus, "ada");
    const { error } = await ada.rpc("membership_set_role", {
      p_tenant_id: tenantIds.get(bandersnatch.slug),
      p_user_id: userIds.get(`${bandersnatch.slug}/rosa`),
      p_role: "manager",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("requires role admin");
  });

  it("illegal stage transitions are refused even for the owner", async () => {
    const riley = clientOf(wumpus, "riley");
    const rileyLead = wumpus.deals.find(
      (d) => d.ownerKey === "riley" && d.targetStage === "lead",
    )!;
    const dealId = await dealIdByName(rileyLead.name);
    const { error } = await riley.from("deals").update({ stage: "won" }).eq("id", dealId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("illegal stage transition");
  });

  it("won is terminal to a raw UPDATE, even for a manager", async () => {
    const morgan = clientOf(wumpus, "morgan");
    const samWon = wumpus.deals.find(
      (d) => d.ownerKey === "sam" && d.targetStage === "won",
    )!;
    const dealId = await dealIdByName(samWon.name);
    const { error } = await morgan
      .from("deals")
      .update({ stage: "qualified" })
      .eq("id", dealId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("illegal stage transition");
  });

  it("a rep cannot reopen (manager/admin act)", async () => {
    const riley = clientOf(wumpus, "riley");
    const samWon = wumpus.deals.find(
      (d) => d.ownerKey === "sam" && d.targetStage === "won",
    )!;
    const { error } = await riley.rpc("deal_reopen", {
      p_deal_id: await dealIdByName(samWon.name),
      p_reason: "should be refused",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("requires role admin or manager");
  });
});

describe("service-plane confinement", () => {
  it("the reset primitive is uncallable below the service role", async () => {
    const ada = clientOf(wumpus, "ada");
    const { error } = await ada.rpc("crm_demo_wipe");
    expect(error).not.toBeNull(); // permission denied at the grant layer

    const { error: anonError } = await anon.rpc("crm_demo_wipe");
    expect(anonError).not.toBeNull();
  });

  it("the service role sees the whole world (it is the server plane)", async () => {
    expect(await countRows(service, "tenants")).toBe(plan.tenants.length);
    const totalDeals = plan.tenants.reduce((sum, t) => sum + t.expected.deals, 0);
    expect(await countRows(service, "deals")).toBe(totalDeals);
    // seed receipts accumulate by design — at least the latest is there
    const receipts = await countRows(service, "job_runs");
    expect(receipts).toBeGreaterThanOrEqual(1);
  });
});

// The audited lifecycle acts run LAST: they deliberately add audit rows,
// which is why exact-count assertions live above them and why re-runs of
// this suite want a fresh seed (npm run db:rebuild).
describe("the audited paths work (and leave a trail)", () => {
  it("admin performs the pending role change, audited, then reverts", async () => {
    const ada = clientOf(wumpus, "ada");
    const samId = userIds.get(`${wumpus.slug}/sam`)!;
    const tenantId = tenantIds.get(wumpus.slug)!;

    const { error } = await ada.rpc("membership_set_role", {
      p_tenant_id: tenantId,
      p_user_id: samId,
      p_role: "manager",
    });
    expect(error).toBeNull();

    const { data: changed } = await ada
      .from("memberships")
      .select("role")
      .eq("user_id", samId)
      .eq("tenant_id", tenantId);
    expect(changed![0]!.role).toBe("manager");

    const { data: audit } = await ada
      .from("audit_log")
      .select("action, detail")
      .eq("action", "membership.role_changed")
      .order("id", { ascending: false })
      .limit(1);
    expect(audit).toHaveLength(1);
    expect(audit![0]!.detail.member).toBe("Sam Farrow");

    const { error: revertError } = await ada.rpc("membership_set_role", {
      p_tenant_id: tenantId,
      p_user_id: samId,
      p_role: "rep",
    });
    expect(revertError).toBeNull();
  });

  it("manager reopens a won deal with a reason, audited, then re-closes", async () => {
    const morgan = clientOf(wumpus, "morgan");
    const ada = clientOf(wumpus, "ada");
    const samWon = wumpus.deals.find(
      (d) => d.ownerKey === "sam" && d.targetStage === "won",
    )!;
    const dealId = await dealIdByName(samWon.name);

    const { error } = await morgan.rpc("deal_reopen", {
      p_deal_id: dealId,
      p_reason: "Renewal terms changed — revisiting close",
    });
    expect(error).toBeNull();

    const { data: reopened } = await morgan
      .from("deals")
      .select("stage, closed_at")
      .eq("id", dealId);
    expect(reopened![0]!.stage).toBe("negotiation");
    expect(reopened![0]!.closed_at).toBeNull();

    const { data: audit } = await ada
      .from("audit_log")
      .select("action, detail")
      .eq("action", "deal.reopened")
      .eq("entity_id", dealId);
    expect(audit!.length).toBeGreaterThanOrEqual(1);

    const { error: recloseError } = await morgan
      .from("deals")
      .update({ stage: "won" })
      .eq("id", dealId);
    expect(recloseError).toBeNull();
  });

  it("a reopen without a reason is refused", async () => {
    const morgan = clientOf(wumpus, "morgan");
    const morganWon = wumpus.deals.find(
      (d) => d.ownerKey === "morgan" && d.targetStage === "won",
    )!;
    const { error } = await morgan.rpc("deal_reopen", {
      p_deal_id: await dealIdByName(morganWon.name),
      p_reason: "  ",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("requires a reason");
  });
});
