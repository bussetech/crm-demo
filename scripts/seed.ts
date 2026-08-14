// The scenario seed runner — deterministic, re-appliable. Wipes the
// tenant-scoped data (crm_demo_wipe, service plane), then rebuilds the
// scenario baseline from src/seed/scenario.ts BY WALKING THE REAL
// LIFECYCLE: orgs/people/deals/activities are created with the seeded
// users' own JWTs (RLS enforced during seeding), and every deal is
// transitioned stage by stage so the triggers write the audit trail.
// A shortcut seed that the triggers reject is the triggers working.
//
// Run via the env bridge (local stack keys): npm run seed
// Against the hosted stack (go-live, CRMDEMO-EPIC1-07): set SUPABASE_URL /
// SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY explicitly.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildScenario,
  dealWalk,
  type SeedUser,
  type TenantPlan,
} from "../src/seed/scenario";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    "error: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY required (run via scripts/stack-env.sh)",
  );
  process.exit(1);
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOptions);

/** unwrap a supabase response or die loudly with context */
const must = <T extends { data: unknown; error: { message: string } | null }>(
  result: T,
  context: string,
): Extract<T, { error: null }>["data"] => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data as Extract<T, { error: null }>["data"];
};

const daysAgoIso = (days: number, hourJitter: number): string =>
  new Date(Date.now() - days * 86_400_000 - hourJitter * 3_600_000).toISOString();

/** ensure every seed auth user exists; returns email → user id */
const ensureAuthUsers = async (users: SeedUser[]): Promise<Map<string, string>> => {
  const existing = must(
    await service.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    "listUsers",
  );
  const byEmail = new Map<string, string>(
    existing.users.map((u) => [u.email ?? "", u.id]),
  );
  const ids = new Map<string, string>();
  for (const user of users) {
    const found = byEmail.get(user.email);
    if (found) {
      ids.set(user.email, found);
      continue;
    }
    const created = must(
      await service.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
        user_metadata: { display_name: user.displayName },
      }),
      `createUser ${user.email}`,
    );
    ids.set(user.email, created.user.id);
  }
  return ids;
};

const signIn = async (user: SeedUser): Promise<SupabaseClient> => {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions);
  must(
    await client.auth.signInWithPassword({ email: user.email, password: user.password }),
    `sign in ${user.email}`,
  );
  return client;
};

const seedTenant = async (
  plan: TenantPlan,
  tenantId: string,
  userIds: Map<string, string>,
): Promise<void> => {
  const idOf = (key: string): string => {
    const user = plan.users.find((u) => u.key === key);
    const id = user && userIds.get(user.email);
    if (!id) throw new Error(`no auth user for key ${key} in ${plan.slug}`);
    return id;
  };

  // memberships: operator-plane provisioning (service role), incl. the
  // deactivated ones — deactivation is data, not a missing row
  must(
    await service.from("memberships").insert(
      plan.users.map((u) => ({
        tenant_id: tenantId,
        user_id: idOf(u.key),
        role: u.role,
        display_name: u.displayName,
        active: u.active,
      })),
    ),
    `${plan.slug}: memberships`,
  );

  // signed-in clients for every ACTIVE user (they author the world)
  const clients = new Map<string, SupabaseClient>();
  for (const user of plan.users.filter((u) => u.active)) {
    clients.set(user.key, await signIn(user));
  }
  const clientOf = (key: string): SupabaseClient => {
    const client = clients.get(key);
    if (!client) throw new Error(`no signed-in client for ${key}`);
    return client;
  };
  const firstManager = plan.users.find((u) => u.active && u.role === "manager");
  if (!firstManager) throw new Error(`${plan.slug}: no active manager to run reopens`);

  // organizations — authored by their planned author, ids minted here so
  // children can reference without lookups
  const orgIds = plan.orgs.map(() => crypto.randomUUID());
  for (const [i, org] of plan.orgs.entries()) {
    must(
      await clientOf(org.authorKey).from("organizations").insert({
        id: orgIds[i],
        tenant_id: tenantId,
        name: org.name,
        domain: org.domain,
        industry: org.industry,
        city: org.city,
        created_by: idOf(org.authorKey),
      }),
      `${plan.slug}: org ${org.name}`,
    );
  }

  const personIds = plan.people.map(() => crypto.randomUUID());
  for (const [i, person] of plan.people.entries()) {
    must(
      await clientOf(person.authorKey).from("people").insert({
        id: personIds[i],
        tenant_id: tenantId,
        org_id: orgIds[person.orgIndex],
        first_name: person.firstName,
        last_name: person.lastName,
        email: person.email,
        title: person.title,
        created_by: idOf(person.authorKey),
      }),
      `${plan.slug}: person ${person.email}`,
    );
  }

  // deals: born at lead by their owner, then walked stage by stage — the
  // triggers audit every step; "REOPEN" is the manager's audited RPC act
  const dealIds = plan.deals.map(() => crypto.randomUUID());
  for (const [i, deal] of plan.deals.entries()) {
    const owner = clientOf(deal.ownerKey);
    must(
      await owner.from("deals").insert({
        id: dealIds[i],
        tenant_id: tenantId,
        org_id: orgIds[deal.orgIndex],
        owner_id: idOf(deal.ownerKey),
        name: deal.name,
        amount: deal.amount,
        created_by: idOf(deal.ownerKey),
      }),
      `${plan.slug}: deal ${deal.name}`,
    );
    for (const step of dealWalk(deal)) {
      if (step === "REOPEN") {
        must(
          await clientOf(firstManager.key).rpc("deal_reopen", {
            p_deal_id: dealIds[i],
            p_reason: "Budget re-approved after renewal review — reopening",
          }),
          `${plan.slug}: reopen ${deal.name}`,
        );
        continue;
      }
      const updated = must(
        await owner.from("deals").update({ stage: step }).eq("id", dealIds[i]).select("id"),
        `${plan.slug}: ${deal.name} -> ${step}`,
      );
      if (updated.length !== 1) {
        throw new Error(`${plan.slug}: ${deal.name} -> ${step} affected ${updated.length} rows`);
      }
    }
  }

  for (const [i, activity] of plan.activities.entries()) {
    must(
      await clientOf(activity.authorKey).from("activities").insert({
        tenant_id: tenantId,
        type: activity.type,
        subject: activity.subject,
        occurred_at: daysAgoIso(activity.daysAgo, i % 8),
        org_id: activity.orgIndex === undefined ? null : orgIds[activity.orgIndex],
        person_id: activity.personIndex === undefined ? null : personIds[activity.personIndex],
        deal_id: activity.dealIndex === undefined ? null : dealIds[activity.dealIndex],
        created_by: idOf(activity.authorKey),
      }),
      `${plan.slug}: activity ${activity.subject}`,
    );
  }
};

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString();
  const plan = buildScenario();

  const userIds = await ensureAuthUsers(plan.tenants.flatMap((t) => t.users));

  // reset to zero, then rebuild — this is what makes the seed re-appliable
  must(await service.rpc("crm_demo_wipe"), "crm_demo_wipe");

  for (const tenant of plan.tenants) {
    const existing = must(
      await service.from("tenants").select("id").eq("slug", tenant.slug).maybeSingle(),
      `${tenant.slug}: lookup`,
    );
    let tenantId = existing?.id as string | undefined;
    if (!tenantId) {
      tenantId = crypto.randomUUID();
      must(
        await service.from("tenants").insert({
          id: tenantId,
          slug: tenant.slug,
          name: tenant.name,
        }),
        `${tenant.slug}: create`,
      );
    }
    await seedTenant(tenant, tenantId, userIds);
    const e = tenant.expected;
    console.log(
      `${tenant.slug}: ${e.organizations} orgs, ${e.people} people, ${e.deals} deals, ` +
        `${e.activities} activities, ${e.memberships} memberships, ${e.auditRows} audit rows`,
    );
  }

  // the honest receipt (stratum law: every job leaves one)
  must(
    await service.from("job_runs").insert({
      job: "seed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: true,
      detail: {
        tenants: plan.tenants.map((t) => ({ slug: t.slug, ...t.expected })),
      },
    }),
    "job_runs receipt",
  );

  console.log("seed complete — scenario baseline rebuilt");
};

main().catch((error) => {
  console.error("seed failed:", error.message ?? error);
  process.exitCode = 1;
});
