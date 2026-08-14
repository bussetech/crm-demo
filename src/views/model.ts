// The read model. Every loader here takes the SIGNED-IN USER'S client, so
// the database decides what comes back — there is no tenant_id parameter
// anywhere in this file, and no route ever supplies one. Cross-tenant
// reads are not blocked here; they return zero rows in the database, which
// is the property the isolation proof pins and test/routes.test.ts pins
// again at the rendered page.

import type { SupabaseClient } from "@supabase/supabase-js";

import { DEAL_STAGES, type DealStage } from "../domain/stages";
import type { MemberRole } from "../domain/roles";
import { toOne } from "../db";

export type Member = {
  id: string;
  userId: string;
  role: MemberRole;
  displayName: string;
  active: boolean;
};

export type Org = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
  createdAt: string;
};

export type Person = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  title: string | null;
  phone: string | null;
  orgId: string;
  orgName: string | null;
};

export type Deal = {
  id: string;
  name: string;
  amount: number;
  stage: DealStage;
  ownerId: string;
  orgId: string;
  orgName: string | null;
  closedAt: string | null;
  updatedAt: string;
};

export type Activity = {
  id: string;
  type: "call" | "email" | "meeting" | "note";
  subject: string;
  body: string | null;
  occurredAt: string;
  createdBy: string;
  orgId: string | null;
  orgName: string | null;
  personId: string | null;
  personName: string | null;
  dealId: string | null;
  dealName: string | null;
};

export type AuditEntry = {
  id: number;
  action: string;
  actorId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

/** A read that failed is never rendered as an empty list — say so instead. */
export class ReadFailed extends Error {}

const rows = <T>(data: unknown, error: { message: string } | null, what: string): T[] => {
  if (error) throw new ReadFailed(`${what}: ${error.message}`);
  return (data ?? []) as T[];
};

const named = (embed: unknown, field: string): string | null => {
  const one = toOne(embed as Record<string, unknown> | Record<string, unknown>[] | null);
  const value = one?.[field];
  return typeof value === "string" ? value : null;
};

// ------------------------------------------------------------ roster

const MEMBER_COLUMNS = "id, user_id, role, display_name, active";

/**
 * The tenant roster — every active member reads it (display_name + role
 * only; the policy exposes no emails). Deals carry an auth user id, so the
 * roster is how a name appears next to one.
 */
export async function loadRoster(db: SupabaseClient): Promise<Member[]> {
  const { data, error } = await db.from("memberships").select(MEMBER_COLUMNS).order("display_name");
  return rows<{
    id: string;
    user_id: string;
    role: MemberRole;
    display_name: string;
    active: boolean;
  }>(data, error, "roster").map((r) => ({
    id: r.id,
    userId: r.user_id,
    role: r.role,
    displayName: r.display_name,
    active: r.active,
  }));
}

export const rosterIndex = (members: Member[]): Map<string, Member> =>
  new Map(members.map((m) => [m.userId, m]));

// ------------------------------------------------------------ organizations

const ORG_COLUMNS = "id, name, domain, industry, city, created_at";

const asOrg = (r: {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
  created_at: string;
}): Org => ({
  id: r.id,
  name: r.name,
  domain: r.domain,
  industry: r.industry,
  city: r.city,
  createdAt: r.created_at,
});

export type OrgSort = "name" | "recent" | "city";

export async function loadOrgs(
  db: SupabaseClient,
  opts: { q?: string; sort?: OrgSort } = {},
): Promise<Org[]> {
  let query = db.from("organizations").select(ORG_COLUMNS);
  if (opts.q) query = query.ilike("name", `%${searchTerm(opts.q)}%`);
  query =
    opts.sort === "recent"
      ? query.order("created_at", { ascending: false })
      : opts.sort === "city"
        ? query.order("city", { ascending: true, nullsFirst: false }).order("name")
        : query.order("name");
  const { data, error } = await query;
  return rows<Parameters<typeof asOrg>[0]>(data, error, "organizations").map(asOrg);
}

export async function loadOrg(db: SupabaseClient, id: string): Promise<Org | null> {
  const { data, error } = await db.from("organizations").select(ORG_COLUMNS).eq("id", id).limit(1);
  const found = rows<Parameters<typeof asOrg>[0]>(data, error, "organization");
  return found.length > 0 ? asOrg(found[0]!) : null;
}

// ------------------------------------------------------------ people

const PERSON_COLUMNS =
  "id, first_name, last_name, email, title, phone, org_id, organizations(name)";

const asPerson = (r: Record<string, unknown>): Person => ({
  id: r["id"] as string,
  firstName: r["first_name"] as string,
  lastName: r["last_name"] as string,
  email: (r["email"] as string | null) ?? null,
  title: (r["title"] as string | null) ?? null,
  phone: (r["phone"] as string | null) ?? null,
  orgId: r["org_id"] as string,
  orgName: named(r["organizations"], "name"),
});

export async function loadPeople(
  db: SupabaseClient,
  opts: { q?: string; orgId?: string } = {},
): Promise<Person[]> {
  let query = db.from("people").select(PERSON_COLUMNS);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  if (opts.q) {
    const term = `%${searchTerm(opts.q)}%`;
    query = query.or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term}`);
  }
  const { data, error } = await query.order("last_name").order("first_name");
  return rows<Record<string, unknown>>(data, error, "people").map(asPerson);
}

export async function loadPerson(db: SupabaseClient, id: string): Promise<Person | null> {
  const { data, error } = await db.from("people").select(PERSON_COLUMNS).eq("id", id).limit(1);
  const found = rows<Record<string, unknown>>(data, error, "person");
  return found.length > 0 ? asPerson(found[0]!) : null;
}

// ------------------------------------------------------------ deals

const DEAL_COLUMNS =
  "id, name, amount, stage, owner_id, org_id, closed_at, updated_at, organizations(name)";

const asDeal = (r: Record<string, unknown>): Deal => ({
  id: r["id"] as string,
  name: r["name"] as string,
  amount: Number(r["amount"] ?? 0),
  stage: r["stage"] as DealStage,
  ownerId: r["owner_id"] as string,
  orgId: r["org_id"] as string,
  orgName: named(r["organizations"], "name"),
  closedAt: (r["closed_at"] as string | null) ?? null,
  updatedAt: r["updated_at"] as string,
});

export async function loadDeals(
  db: SupabaseClient,
  opts: { stage?: DealStage; ownerId?: string; orgId?: string } = {},
): Promise<Deal[]> {
  let query = db.from("deals").select(DEAL_COLUMNS);
  if (opts.stage) query = query.eq("stage", opts.stage);
  if (opts.ownerId) query = query.eq("owner_id", opts.ownerId);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const { data, error } = await query.order("amount", { ascending: false });
  return rows<Record<string, unknown>>(data, error, "deals").map(asDeal);
}

export async function loadDeal(db: SupabaseClient, id: string): Promise<Deal | null> {
  const { data, error } = await db.from("deals").select(DEAL_COLUMNS).eq("id", id).limit(1);
  const found = rows<Record<string, unknown>>(data, error, "deal");
  return found.length > 0 ? asDeal(found[0]!) : null;
}

export type BoardColumn = { stage: DealStage; deals: Deal[]; total: number };

/**
 * The pipeline board: every stage is a column, including the terminal
 * ones, and an empty stage renders as an empty column rather than
 * disappearing — the board shows the pipeline it actually has.
 */
export const boardOf = (deals: Deal[]): BoardColumn[] =>
  DEAL_STAGES.map((stage) => {
    const inStage = deals.filter((d) => d.stage === stage);
    return {
      stage,
      deals: inStage,
      total: inStage.reduce((sum, d) => sum + d.amount, 0),
    };
  });

// ------------------------------------------------------------ activities

const ACTIVITY_COLUMNS =
  "id, type, subject, body, occurred_at, created_by, org_id, person_id, deal_id," +
  " organizations(name), people(first_name, last_name), deals(name)";

const asActivity = (r: Record<string, unknown>): Activity => {
  const person = toOne(
    r["people"] as Record<string, unknown> | Record<string, unknown>[] | null,
  );
  const personName = person
    ? `${person["first_name"] as string} ${person["last_name"] as string}`
    : null;
  return {
    id: r["id"] as string,
    type: r["type"] as Activity["type"],
    subject: r["subject"] as string,
    body: (r["body"] as string | null) ?? null,
    occurredAt: r["occurred_at"] as string,
    createdBy: r["created_by"] as string,
    orgId: (r["org_id"] as string | null) ?? null,
    orgName: named(r["organizations"], "name"),
    personId: (r["person_id"] as string | null) ?? null,
    personName,
    dealId: (r["deal_id"] as string | null) ?? null,
    dealName: named(r["deals"], "name"),
  };
};

export async function loadActivities(
  db: SupabaseClient,
  opts: {
    type?: Activity["type"];
    orgId?: string;
    personId?: string;
    dealId?: string;
    authorId?: string;
    limit?: number;
  } = {},
): Promise<Activity[]> {
  let query = db.from("activities").select(ACTIVITY_COLUMNS);
  if (opts.type) query = query.eq("type", opts.type);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  if (opts.personId) query = query.eq("person_id", opts.personId);
  if (opts.dealId) query = query.eq("deal_id", opts.dealId);
  if (opts.authorId) query = query.eq("created_by", opts.authorId);
  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    .limit(opts.limit ?? 50);
  return rows<Record<string, unknown>>(data, error, "activities").map(asActivity);
}

// ------------------------------------------------------------ audit trail

/**
 * A deal's stage history comes from the audit rows the transition trigger
 * wrote. The audit log is admin-eyes-only by policy, so a rep or manager
 * reads ZERO rows here — which the deal page states plainly rather than
 * rendering as "no history".
 */
export async function loadDealHistory(db: SupabaseClient, dealId: string): Promise<AuditEntry[]> {
  const { data, error } = await db
    .from("audit_log")
    .select("id, action, actor_id, detail, created_at")
    .eq("entity_id", dealId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return rows<{
    id: number;
    action: string;
    actor_id: string | null;
    detail: Record<string, unknown>;
    created_at: string;
  }>(data, error, "deal history").map((r) => ({
    id: r.id,
    action: r.action,
    actorId: r.actor_id,
    detail: r.detail ?? {},
    createdAt: r.created_at,
  }));
}

// ------------------------------------------------------------ helpers

/**
 * A search box types a word, not a pattern and not filter syntax. LIKE
 * wildcards (`%`, `_`) and the characters PostgREST's own filter grammar
 * reads (`,`, `.`, `(`, `)`, `:`, quotes, backslash) are dropped rather
 * than escaped — a demo search wants predictable, not clever — and the
 * term is length-capped so a query string cannot grow a request.
 */
export const searchTerm = (raw: string): string =>
  raw.replace(/[%_\\"'(),.:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
