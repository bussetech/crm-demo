// The scenario seed ENGINE — deterministic, re-appliable, and platform
// neutral: no process.*, no Node-only imports, so the same code runs from
// the Node wrapper (scripts/seed.ts) and from the Worker's reset job
// (src/jobs/reset.ts). One engine, two doors — the reset job cannot drift
// from the seed because they are the same function.
//
// It wipes the tenant-scoped data (crm_demo_wipe, service plane), then
// rebuilds the scenario baseline from src/seed/scenario.ts BY WALKING THE
// REAL LIFECYCLE: orgs/people/deals/activities are created with the seeded
// users' own JWTs (RLS enforced during seeding), and every deal is
// transitioned stage by stage so the triggers write the audit trail.
// A shortcut seed that the triggers reject is the triggers working.
//
// The engine journals NOTHING: each caller writes its own job_runs
// receipt (job: "seed" for the CLI, job: "reset" for the job), because the
// receipt is the caller's honesty, not the engine's.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildScenario,
  dealWalk,
  type SeedUser,
  type TenantExpectations,
  type TenantPlan,
} from "./scenario";

export interface SeedTarget {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  /** progress lines — console.log for the CLI, Workers Logs for the job */
  log?: (line: string) => void;
}

export type TenantSummary = TenantExpectations & { slug: string };

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/** The service-plane client for a target. Exported for the job's receipts. */
export const serviceClient = (target: SeedTarget): SupabaseClient =>
  createClient(target.url, target.serviceRoleKey, clientOptions);

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
const ensureAuthUsers = async (
  service: SupabaseClient,
  users: SeedUser[],
): Promise<Map<string, string>> => {
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

const signIn = async (target: SeedTarget, user: SeedUser): Promise<SupabaseClient> => {
  const client = createClient(target.url, target.anonKey, clientOptions);
  must(
    await client.auth.signInWithPassword({ email: user.email, password: user.password }),
    `sign in ${user.email}`,
  );
  return client;
};

const seedTenant = async (
  target: SeedTarget,
  service: SupabaseClient,
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
    clients.set(user.key, await signIn(target, user));
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

/**
 * Reset to zero, then rebuild the scenario baseline — the whole engine.
 * Wipes tenant-scoped data (tenants themselves survive and are matched by
 * slug; auth accounts survive and are matched by email, which is what
 * makes a reset restore DEMO-ACCOUNT STATE as well as data: memberships —
 * roles, deactivations — are rebuilt from the plan every run).
 */
export const restoreBaseline = async (target: SeedTarget): Promise<TenantSummary[]> => {
  const log = target.log ?? (() => {});
  const service = serviceClient(target);
  const plan = buildScenario();

  const userIds = await ensureAuthUsers(service, plan.tenants.flatMap((t) => t.users));

  // reset to zero, then rebuild — this is what makes the seed re-appliable
  must(await service.rpc("crm_demo_wipe"), "crm_demo_wipe");

  const summaries: TenantSummary[] = [];
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
    await seedTenant(target, service, tenant, tenantId, userIds);
    const e = tenant.expected;
    summaries.push({ slug: tenant.slug, ...e });
    log(
      `${tenant.slug}: ${e.organizations} orgs, ${e.people} people, ${e.deals} deals, ` +
        `${e.activities} activities, ${e.memberships} memberships, ${e.auditRows} audit rows`,
    );
  }
  return summaries;
};
