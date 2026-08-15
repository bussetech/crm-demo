// The published demo logins, and the posture statements that go with them.
//
// THE CREDENTIALS PAGE IS PART OF THE PRODUCT: it is the front door of the
// demo, the first thing a prospect reads, and a stale one is a failed
// demo. So it is not written down anywhere — it is DERIVED FROM THE SEED
// PLAN (src/seed/scenario.ts), the same module scripts/seed.ts provisions
// accounts from. One source, two consumers: a login that is not on the
// page cannot exist, and a login on the page that does not work is a
// broken seed rather than stale copy. test/routes.test.ts closes the loop
// by signing in with every credential this module publishes.
//
// Publishing them is a deliberate, contained posture, not an oversight
// (ADR-0055 §3, track law 3): self-signup is disabled, accounts are
// seed-provisioned, every address is under the reserved `.example` TLD,
// and the blast radius of anything anyone does with them is one synthetic
// tenant until the next reset.

import type { MemberRole } from "../domain/roles";
import { buildScenario } from "../seed/scenario";

export type DemoLogin = {
  displayName: string;
  role: MemberRole;
  active: boolean;
  email: string;
  password: string;
};

export type DemoTenant = {
  slug: string;
  name: string;
  logins: DemoLogin[];
};

/**
 * Built once per isolate: the plan is pure and deterministic, so this is a
 * constant that happens to be computed rather than typed out.
 */
const TENANTS: DemoTenant[] = buildScenario().tenants.map((tenant) => ({
  slug: tenant.slug,
  name: tenant.name,
  logins: tenant.users.map((user) => ({
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    email: user.email,
    password: user.password,
  })),
}));

export const demoTenants = (): DemoTenant[] => TENANTS;

/** What each persona is for — the reason to sign in as this one and not that one. */
export const PERSONA: Record<MemberRole, string> = {
  admin:
    "Sees everything a manager sees, plus the tenant's audit trail and the user roster. Governs roles and access; does not create accounts.",
  manager:
    "Works any deal in the tenant, reopens closed ones with a reason that is recorded, and reads the pipeline as numbers.",
  rep: "Works their own book: adds organizations and contacts, logs activity, moves their own deals. Cannot touch another rep's deals, and cannot read the audit trail.",
};

/**
 * The reset posture.
 *
 * `scheduled` is the honest-capture switch. GD-0035 ruled the cadence —
 * nightly at 04:00 ET, plus an on-demand dispatch and a demo-freeze
 * switch — but a ruling is not a running job, and this demo's front door
 * must not describe unbuilt things as running (track law 5). The reset job
 * is CRMDEMO-EPIC1-06's build.
 *
 * ***THE SESSION THAT SHIPS THE RESET JOB FLIPS THIS TO `true`.*** It is
 * the one edit that changes what the credentials page and the standing
 * banner both say, because both read it here.
 */
export const RESET_POSTURE = {
  scheduled: false,
  cadence: "nightly at 04:00 ET",
} as const;

/** The banner one-liner, on every page, signed in or not. */
export const BANNER_TEXT = RESET_POSTURE.scheduled
  ? "Demo environment — synthetic data, resets on schedule."
  : "Demo environment — synthetic data, reset by hand until the scheduled reset ships.";

/**
 * One sentence, for the banner that rides every page. The long version
 * lives on the credentials page — a banner nobody can dismiss earns its
 * space by being short.
 */
export const resetBanner = (): string =>
  RESET_POSTURE.scheduled
    ? `Data resets to the scenario baseline ${RESET_POSTURE.cadence}, so anything you change is temporary — and visible to everyone using this tenant until then.`
    : `The scheduled reset is not running yet, so anything you change persists until the studio restores the baseline by hand — and is visible to everyone using this tenant.`;

/** The full statement, for the credentials page. */
export const resetCopy = (): string =>
  RESET_POSTURE.scheduled
    ? `Data resets to the scenario baseline ${RESET_POSTURE.cadence}, and can be reset on request before a walkthrough. Anything you change is temporary, and is visible to everyone using the same tenant until then.`
    : `The scheduled reset is not running yet — today the studio restores the baseline by hand, on request. The schedule that is coming (${RESET_POSTURE.cadence}, plus an on-demand reset and a freeze switch for live walkthroughs) is decided but not yet built, so it is described here as what it is. Anything you change persists until someone asks for a reset, and is visible to everyone using the same tenant.`;
