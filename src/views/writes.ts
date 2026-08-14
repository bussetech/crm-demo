// The write model — the mutation twin of model.ts, and the only place in
// the app where a row is created or changed.
//
// Three properties hold here, and every one of them is load-bearing:
//
//  1. EVERY mutation runs on the SIGNED-IN USER'S client, exactly like a
//     read. There is no privileged path, no service-role escape hatch, and
//     no binding one could be built from (src/env.ts). A write a user may
//     not make does not need to be caught here, because the database will
//     not perform it.
//
//  2. NO tenant id comes from a request. Inserts do carry `tenant_id` —
//     the column is NOT NULL and has no default — but it comes from
//     `profile.tenant.id`, which was itself READ THROUGH THE USER'S OWN
//     JWT at sign-in (src/auth.ts loadProfile). It is a value the database
//     already agreed to; RLS's WITH CHECK re-agrees on every insert. If a
//     future handler ever passes a tenant id that arrived in a form, that
//     is the bug — not this parameter.
//
//  3. BUSINESS RULES ARE NOT RE-DERIVED. The domain modules
//     (src/domain/*) say what is well-formed and hand back a friendly
//     reason; the database says what is PERMITTED. This module never
//     decides that a rep may not touch a deal, or that lead → won is
//     illegal — it asks, and reports the refusal.
//
// The result type distinguishes the three refusals a demo audience needs
// told apart: bad input (fix the form), a database refusal (a rule spoke,
// here is what it said), and zero rows affected (not yours, or gone — and
// the app does not say which, for the same reason a foreign id reads as
// 404 rather than 403).

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CrmProfile } from "../env";
import type { ActivityType } from "../domain/activity";
import type { DealStage } from "../domain/stages";
import {
  validateActivityBody,
  validateActivityLinks,
  validateActivitySubject,
  validateDealAmount,
  validateDealName,
  validateEmail,
  validateOrganizationDomain,
  validateOrganizationName,
  validatePersonName,
  validateReopenReason,
  type ValidationResult,
} from "../domain/validation";

export type WriteResult<T> =
  | { ok: true; value: T }
  /** the domain module refused the input — the form can say why, friendly */
  | { ok: false; kind: "invalid"; reason: string }
  /** the database refused the write — a rule spoke; nothing was written */
  | { ok: false; kind: "refused"; reason: string }
  /** zero rows: not this reader's to change, or no longer there */
  | { ok: false; kind: "missing" };

const invalid = (reason: string): WriteResult<never> => ({ ok: false, kind: "invalid", reason });
const missing = (): WriteResult<never> => ({ ok: false, kind: "missing" });

/** First failing check wins, so a form reports one fixable thing at a time. */
const firstFailure = (checks: ValidationResult[]): string | null => {
  for (const check of checks) if (!check.ok) return check.reason;
  return null;
};

/**
 * Refusals this app RAISED ON PURPOSE (02's triggers and RPCs) are written
 * for humans, so they are shown verbatim — that is the point of having
 * phrased them carefully. Anything else is a constraint or a driver
 * talking about its own internals: honest that the database refused,
 * without teaching a public demo audience the schema. The detail still
 * goes to the log.
 */
const DELIBERATE_REFUSALS = [
  "illegal stage transition",
  "deals are born at stage lead",
  "deal owner must be an active member",
  "a new deal cannot carry closed_at",
  "closed_at is trigger-maintained",
  "tenant_id is immutable",
  "org_id is immutable",
  "requires role",
  "requires a reason",
  "only a won or lost deal can be reopened",
  "authentication required",
  "deal not found",
  "you cannot change your own role",
  "you cannot deactivate your own membership",
] as const;

const refused = (error: { message: string }, what: string): WriteResult<never> => {
  const spoken = DELIBERATE_REFUSALS.find((phrase) => error.message.includes(phrase));
  if (!spoken) {
    console.error("write refused", { what, error: error.message });
  }
  return {
    ok: false,
    kind: "refused",
    reason: spoken
      ? error.message
      : "The database refused this change, so nothing was written. The value is outside what this record allows.",
  };
};

/** An insert that returns its id, or the refusal that stopped it. */
async function insertOne(
  db: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<WriteResult<string>> {
  const { data, error } = await db.from(table).insert(row).select("id").limit(1);
  if (error) return refused(error, `insert ${table}`);
  const id = (data ?? [])[0]?.id as string | undefined;
  // A satisfied INSERT policy returns the row. No row here would mean the
  // insert landed somewhere this reader cannot see it back, which is not a
  // state this schema can produce — treat it as a refusal rather than
  // pretending to have an id.
  return id ? { ok: true, value: id } : missing();
}

/**
 * An update scoped by id. RLS's USING clause is the ownership filter, so a
 * row this reader may not change simply is not matched — zero rows, no
 * error, exactly like a denied read.
 */
async function updateOne(
  db: SupabaseClient,
  table: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<WriteResult<string>> {
  const { data, error } = await db.from(table).update(patch).eq("id", id).select("id");
  if (error) return refused(error, `update ${table}`);
  return (data ?? []).length === 1 ? { ok: true, value: id } : missing();
}

// ------------------------------------------------------------ organizations

export type OrgInput = {
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
};

const checkOrg = (input: OrgInput): string | null =>
  firstFailure([
    validateOrganizationName(input.name),
    validateOrganizationDomain(input.domain),
  ]);

export async function createOrganization(
  db: SupabaseClient,
  profile: CrmProfile,
  input: OrgInput,
): Promise<WriteResult<string>> {
  const bad = checkOrg(input);
  if (bad) return invalid(bad);
  return insertOne(db, "organizations", {
    tenant_id: profile.tenant.id,
    name: input.name.trim(),
    domain: input.domain,
    industry: input.industry,
    city: input.city,
    created_by: profile.userId,
  });
}

export async function updateOrganization(
  db: SupabaseClient,
  id: string,
  input: OrgInput,
): Promise<WriteResult<string>> {
  const bad = checkOrg(input);
  if (bad) return invalid(bad);
  return updateOne(db, "organizations", id, {
    name: input.name.trim(),
    domain: input.domain,
    industry: input.industry,
    city: input.city,
  });
}

// ------------------------------------------------------------ people

export type PersonInput = {
  firstName: string;
  lastName: string;
  email: string | null;
  title: string | null;
  phone: string | null;
  orgId: string;
};

const checkPerson = (input: PersonInput): string | null =>
  firstFailure([
    validatePersonName(input.firstName),
    validatePersonName(input.lastName),
    validateEmail(input.email),
  ]);

export async function createPerson(
  db: SupabaseClient,
  profile: CrmProfile,
  input: PersonInput,
): Promise<WriteResult<string>> {
  const bad = checkPerson(input);
  if (bad) return invalid(bad);
  // org_id is not checked here on purpose: the composite foreign key
  // (tenant_id, org_id) means a foreign organization cannot be referenced
  // at all — the linkage is structural, not a lookup this code performs.
  return insertOne(db, "people", {
    tenant_id: profile.tenant.id,
    org_id: input.orgId,
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    email: input.email,
    title: input.title,
    phone: input.phone,
    created_by: profile.userId,
  });
}

export async function updatePerson(
  db: SupabaseClient,
  id: string,
  input: PersonInput,
): Promise<WriteResult<string>> {
  const bad = checkPerson(input);
  if (bad) return invalid(bad);
  return updateOne(db, "people", id, {
    org_id: input.orgId,
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    email: input.email,
    title: input.title,
    phone: input.phone,
  });
}

// ------------------------------------------------------------ deals

export type DealInput = {
  name: string;
  amount: number;
  orgId: string;
  ownerId: string;
};

const checkDeal = (input: DealInput): string | null =>
  firstFailure([validateDealName(input.name), validateDealAmount(input.amount)]);

/**
 * A deal is born at `lead` and nowhere else — the insert trigger says so,
 * so this does not pass a stage at all. Whether this user may own it (a
 * rep only for themselves) is the INSERT policy's call.
 */
export async function createDeal(
  db: SupabaseClient,
  profile: CrmProfile,
  input: DealInput,
): Promise<WriteResult<string>> {
  const bad = checkDeal(input);
  if (bad) return invalid(bad);
  return insertOne(db, "deals", {
    tenant_id: profile.tenant.id,
    org_id: input.orgId,
    owner_id: input.ownerId,
    name: input.name.trim(),
    amount: input.amount,
    created_by: profile.userId,
  });
}

export async function updateDeal(
  db: SupabaseClient,
  id: string,
  input: DealInput,
): Promise<WriteResult<string>> {
  const bad = checkDeal(input);
  if (bad) return invalid(bad);
  // org_id is immutable (the update guard raises on a change), so an edit
  // never sends it. Reassigning an owner is a manager/admin act enforced
  // by the UPDATE policy's WITH CHECK.
  return updateOne(db, "deals", id, {
    name: input.name.trim(),
    amount: input.amount,
    owner_id: input.ownerId,
  });
}

/**
 * A stage move, handed to the database UNJUDGED.
 *
 * This is deliberate and it is the invariant test/writes.test.ts pins: the
 * caller does not ask `isTransitionAllowed` first. The pipeline board and
 * the deal page use `allowedTransitions` to OFFER only legal moves, but a
 * crafted request that skips the form must meet the same refusal the form
 * would have avoided — and it does, because the refusal was never the
 * form's to make.
 */
export async function setDealStage(
  db: SupabaseClient,
  id: string,
  stage: DealStage,
): Promise<WriteResult<string>> {
  return updateOne(db, "deals", id, { stage });
}

/**
 * The only exit from won/lost, and an RPC rather than an update because it
 * is a privileged act: manager/admin, reason required, audited, and the
 * transaction-local gate it sets is the only thing the stage trigger will
 * accept as authorization to leave a terminal stage.
 */
export async function reopenDeal(
  db: SupabaseClient,
  id: string,
  reason: string,
): Promise<WriteResult<string>> {
  const bad = firstFailure([validateReopenReason(reason)]);
  if (bad) return invalid(bad);
  const { error } = await db.rpc("deal_reopen", { p_deal_id: id, p_reason: reason.trim() });
  if (error) return refused(error, "deal_reopen");
  return { ok: true, value: id };
}

// ------------------------------------------------------------ activities

export type ActivityInput = {
  type: ActivityType;
  subject: string;
  body: string | null;
  orgId: string | null;
  personId: string | null;
  dealId: string | null;
};

export async function logActivity(
  db: SupabaseClient,
  profile: CrmProfile,
  input: ActivityInput,
): Promise<WriteResult<string>> {
  const bad = firstFailure([
    validateActivitySubject(input.subject),
    validateActivityBody(input.body),
    validateActivityLinks({
      orgId: input.orgId,
      personId: input.personId,
      dealId: input.dealId,
    }),
  ]);
  if (bad) return invalid(bad);
  return insertOne(db, "activities", {
    tenant_id: profile.tenant.id,
    type: input.type,
    subject: input.subject.trim(),
    body: input.body,
    // The clock is the server's. An activity form that let a caller name
    // its own timestamp would let a demo visitor bury the trail.
    occurred_at: new Date().toISOString(),
    org_id: input.orgId,
    person_id: input.personId,
    deal_id: input.dealId,
    created_by: profile.userId,
  });
}
