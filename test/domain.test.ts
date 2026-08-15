// Domain gates, runnable without a database (stratum law: invariants live
// in the DB AND in pure-TS twins). These tests are the executable spec of
// the rules the migrations enforce with triggers/CHECKs — if a rule moves
// here, it must move there too.
import { describe, expect, it } from "vitest";

import {
  DEAL_STAGES,
  INITIAL_STAGE,
  OPEN_STAGES,
  advancePath,
  allowedTransitions,
  isOpenStage,
  isTerminalStage,
  isTransitionAllowed,
} from "../src/domain/stages";
import {
  canCreateDeal,
  canCreateRecords,
  canManageMemberships,
  canReadAuditLog,
  canReadTenantData,
  canReopenDeal,
  canUpdateDeal,
  type Membership,
} from "../src/domain/roles";
import {
  ACTIVITY_BODY_MAX,
  validateActivityBody,
  validateActivityLinks,
  validateDealAmount,
  validateEmail,
  validateOrganizationDomain,
  validateOrganizationName,
  validateReopenReason,
} from "../src/domain/validation";
import { ACTIVITY_TYPES, isActivityType } from "../src/domain/activity";
import { auditRowsForDeal, buildScenario, dealWalk } from "../src/seed/scenario";

const admin: Membership = { role: "admin", active: true };
const manager: Membership = { role: "manager", active: true };
const rep: Membership = { role: "rep", active: true };
const deactivated: Membership = { role: "admin", active: false };

describe("pipeline stages", () => {
  it("deals are born at lead", () => {
    expect(INITIAL_STAGE).toBe("lead");
  });

  it("classifies open and terminal stages", () => {
    for (const stage of OPEN_STAGES) expect(isOpenStage(stage)).toBe(true);
    expect(isTerminalStage("won")).toBe(true);
    expect(isTerminalStage("lost")).toBe(true);
    expect(isOpenStage("won")).toBe(false);
  });

  it("open stages move freely among themselves, both directions", () => {
    expect(isTransitionAllowed("lead", "qualified")).toBe(true);
    expect(isTransitionAllowed("lead", "negotiation")).toBe(true); // skip forward
    expect(isTransitionAllowed("negotiation", "lead")).toBe(true); // re-qualify
    expect(isTransitionAllowed("proposal", "qualified")).toBe(true);
  });

  it("won is reachable only from negotiation", () => {
    expect(isTransitionAllowed("negotiation", "won")).toBe(true);
    expect(isTransitionAllowed("lead", "won")).toBe(false);
    expect(isTransitionAllowed("qualified", "won")).toBe(false);
    expect(isTransitionAllowed("proposal", "won")).toBe(false);
  });

  it("lost is reachable from any open stage", () => {
    for (const stage of OPEN_STAGES) {
      expect(isTransitionAllowed(stage, "lost")).toBe(true);
    }
  });

  it("won/lost are terminal without an audited reopen", () => {
    for (const terminal of ["won", "lost"] as const) {
      for (const to of DEAL_STAGES) {
        if (to === terminal) continue;
        expect(isTransitionAllowed(terminal, to)).toBe(false);
      }
    }
  });

  it("a reopen exits a terminal stage to negotiation only", () => {
    expect(isTransitionAllowed("won", "negotiation", { reopen: true })).toBe(true);
    expect(isTransitionAllowed("lost", "negotiation", { reopen: true })).toBe(true);
    expect(isTransitionAllowed("won", "lead", { reopen: true })).toBe(false);
    expect(isTransitionAllowed("won", "qualified", { reopen: true })).toBe(false);
  });

  it("no self-transitions", () => {
    for (const stage of DEAL_STAGES) {
      expect(isTransitionAllowed(stage, stage, { reopen: true })).toBe(false);
    }
  });

  it("advancePath walks the ladder from lead", () => {
    expect(advancePath("negotiation")).toEqual([
      "lead", "qualified", "proposal", "negotiation",
    ]);
    expect(advancePath("lead")).toEqual(["lead"]);
    expect(() => advancePath("won")).toThrow();
  });
});

describe("role capabilities", () => {
  it("a deactivated member is a stranger everywhere", () => {
    expect(canReadTenantData(deactivated)).toBe(false);
    expect(canCreateRecords(deactivated)).toBe(false);
    expect(canCreateDeal(deactivated, true)).toBe(false);
    expect(canUpdateDeal(deactivated, true)).toBe(false);
    expect(canManageMemberships(deactivated)).toBe(false);
    expect(canReadAuditLog(deactivated)).toBe(false);
  });

  it("every active member reads tenant data and creates records", () => {
    for (const m of [admin, manager, rep]) {
      expect(canReadTenantData(m)).toBe(true);
      expect(canCreateRecords(m)).toBe(true);
    }
  });

  it("reps create and work only their own deals", () => {
    expect(canCreateDeal(rep, true)).toBe(true);
    expect(canCreateDeal(rep, false)).toBe(false);
    expect(canUpdateDeal(rep, true)).toBe(true);
    expect(canUpdateDeal(rep, false)).toBe(false);
  });

  it("managers and admins work any deal and may reopen", () => {
    for (const m of [admin, manager]) {
      expect(canCreateDeal(m, false)).toBe(true);
      expect(canUpdateDeal(m, false)).toBe(true);
      expect(canReopenDeal(m)).toBe(true);
    }
    expect(canReopenDeal(rep)).toBe(false);
  });

  it("membership administration and the audit log are admin-only", () => {
    expect(canManageMemberships(admin)).toBe(true);
    expect(canManageMemberships(manager)).toBe(false);
    expect(canManageMemberships(rep)).toBe(false);
    expect(canReadAuditLog(admin)).toBe(true);
    expect(canReadAuditLog(manager)).toBe(false);
    expect(canReadAuditLog(rep)).toBe(false);
  });
});

describe("validation", () => {
  it("names must be non-empty within bounds", () => {
    expect(validateOrganizationName("Gizmo Garden Supply").ok).toBe(true);
    expect(validateOrganizationName("   ").ok).toBe(false);
    expect(validateOrganizationName("x".repeat(121)).ok).toBe(false);
  });

  it("emails are optional but must be shaped", () => {
    expect(validateEmail(null).ok).toBe(true);
    expect(validateEmail("rowan.fernsby@gizmo-garden-supply.example").ok).toBe(true);
    expect(validateEmail("not-an-email").ok).toBe(false);
  });

  it("amounts are finite and non-negative", () => {
    expect(validateDealAmount(4500).ok).toBe(true);
    expect(validateDealAmount(0).ok).toBe(true);
    expect(validateDealAmount(-1).ok).toBe(false);
    expect(validateDealAmount(Number.NaN).ok).toBe(false);
  });

  it("activities must link somewhere", () => {
    expect(validateActivityLinks({ dealId: "d" }).ok).toBe(true);
    expect(validateActivityLinks({ orgId: "o", personId: "p" }).ok).toBe(true);
    expect(validateActivityLinks({}).ok).toBe(false);
  });

  it("reopens require a reason", () => {
    expect(validateReopenReason("Budget re-approved").ok).toBe(true);
    expect(validateReopenReason("  ").ok).toBe(false);
  });
});

describe("the scenario plan (seed = spec)", () => {
  const plan = buildScenario();
  const wumpus = plan.tenants[0]!;

  it("is deterministic", () => {
    expect(buildScenario()).toEqual(plan);
  });

  it("covers the pipeline walkthrough: every stage, recent won AND lost", () => {
    for (const stage of DEAL_STAGES) {
      expect(wumpus.expected.dealsByStage[stage]).toBeGreaterThan(0);
    }
    expect(wumpus.expected.organizations).toBeGreaterThanOrEqual(12);
    expect(wumpus.expected.people).toBeGreaterThanOrEqual(30);
  });

  it("gives every mid-pipeline deal an activity trail", () => {
    wumpus.deals.forEach((deal, dealIndex) => {
      if (!["qualified", "proposal", "negotiation"].includes(deal.targetStage)) return;
      const trail = wumpus.activities.filter((a) => a.dealIndex === dealIndex);
      expect(trail.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("shapes the manager view: uneven stages and an activity spike", () => {
    const byStage = wumpus.expected.dealsByStage;
    expect(byStage.lead).not.toBe(byStage.negotiation);
    const spike = wumpus.activities.filter(
      (a) => a.authorKey === "riley" && a.daysAgo <= 3,
    );
    expect(spike.length).toBeGreaterThanOrEqual(8);
  });

  it("covers the admin scenario: all three roles, active + deactivated", () => {
    for (const tenant of plan.tenants) {
      const roles = new Set(tenant.users.map((u) => u.role));
      expect(roles).toEqual(new Set(["admin", "manager", "rep"]));
      expect(tenant.users.some((u) => !u.active)).toBe(true);
      expect(tenant.users.some((u) => u.active)).toBe(true);
    }
  });

  it("makes the isolation beat land: tenant B is a full world", () => {
    const bandersnatch = plan.tenants[1]!;
    expect(bandersnatch.expected.organizations).toBeGreaterThanOrEqual(8);
    expect(bandersnatch.expected.deals).toBeGreaterThanOrEqual(12);
    expect(bandersnatch.expected.dealsByStage.won).toBeGreaterThan(0);
  });

  it("keeps every identity synthetic (.example everywhere)", () => {
    for (const tenant of plan.tenants) {
      for (const user of tenant.users) expect(user.email.endsWith(".example")).toBe(true);
      for (const org of tenant.orgs) expect(org.domain.endsWith(".example")).toBe(true);
      for (const person of tenant.people) expect(person.email.endsWith(".example")).toBe(true);
    }
  });

  it("walks every deal legally from lead (the seed obeys the triggers)", () => {
    for (const tenant of plan.tenants) {
      for (const deal of tenant.deals) {
        let stage = INITIAL_STAGE;
        for (const step of dealWalk(deal)) {
          if (step === "REOPEN") {
            expect(isTerminalStage(stage)).toBe(true);
            expect(isTransitionAllowed(stage, "negotiation", { reopen: true })).toBe(true);
            stage = "negotiation";
            continue;
          }
          expect(isTransitionAllowed(stage, step)).toBe(true);
          stage = step;
        }
        expect(stage).toBe(deal.targetStage);
      }
    }
  });

  it("prices the audit trail exactly (the proof's expected counts)", () => {
    // spot-check the arithmetic the proof relies on
    expect(auditRowsForDeal({ ...wumpus.deals[0]!, targetStage: "lead" })).toBe(0);
    expect(auditRowsForDeal({ ...wumpus.deals[0]!, targetStage: "won", reopened: false })).toBe(4);
    expect(auditRowsForDeal({ ...wumpus.deals[0]!, targetStage: "won", reopened: true })).toBe(7);
    expect(
      auditRowsForDeal({ ...wumpus.deals[0]!, targetStage: "lost", lostFrom: "negotiation" }),
    ).toBe(4);
    // ...and since CRMDEMO-EPIC1-04 the trail also carries one row per
    // record created, which is what makes "the audit trail shows every
    // step" a true sentence about the day-in-the-life walk.
    const walk = wumpus.deals.reduce((sum, d) => sum + auditRowsForDeal(d), 0);
    const created =
      wumpus.orgs.length +
      wumpus.people.length +
      wumpus.deals.length +
      wumpus.activities.length;
    expect(wumpus.expected.auditRows).toBe(walk + created);
  });
});

describe("the moves a stage control may offer", () => {
  it("offers every legal move and only legal moves, at every stage", () => {
    for (const from of DEAL_STAGES) {
      const offered = allowedTransitions(from);
      for (const to of DEAL_STAGES) {
        expect(
          offered.includes(to),
          `${from} -> ${to} offered but ${isTransitionAllowed(from, to) ? "legal" : "illegal"}`,
        ).toBe(isTransitionAllowed(from, to));
      }
    }
  });

  it("never offers a move out of a closed deal — the reopen RPC is the only exit", () => {
    for (const stage of DEAL_STAGES.filter(isTerminalStage)) {
      expect(allowedTransitions(stage)).toEqual([]);
      expect(allowedTransitions(stage, { reopen: true })).toEqual(["negotiation"]);
    }
  });

  it("lets an open deal close either way, and won only from negotiation", () => {
    expect(allowedTransitions("negotiation")).toContain("won");
    for (const stage of OPEN_STAGES) {
      expect(allowedTransitions(stage)).toContain("lost");
      if (stage !== "negotiation") expect(allowedTransitions(stage)).not.toContain("won");
    }
  });

  it("never offers a deal its own stage", () => {
    for (const stage of DEAL_STAGES) expect(allowedTransitions(stage)).not.toContain(stage);
  });
});

describe("the write-form validators (04)", () => {
  it("treats a note body as optional and bounded", () => {
    expect(validateActivityBody(null).ok).toBe(true);
    expect(validateActivityBody("").ok).toBe(true);
    expect(validateActivityBody("x".repeat(ACTIVITY_BODY_MAX)).ok).toBe(true);
    expect(validateActivityBody("x".repeat(ACTIVITY_BODY_MAX + 1)).ok).toBe(false);
  });

  it("keeps the body bound under the Worker's 4 KB request cap", () => {
    // if these ever cross, a long note becomes a bare 413 instead of a
    // friendly message — the reason the bound exists at all
    expect(ACTIVITY_BODY_MAX).toBeLessThan(4096);
  });

  it("accepts a bare domain and refuses a URL", () => {
    expect(validateOrganizationDomain(null).ok).toBe(true);
    expect(validateOrganizationDomain("gizmo-garden-supply.example").ok).toBe(true);
    expect(validateOrganizationDomain("https://gizmo.example/path").ok).toBe(false);
    expect(validateOrganizationDomain("Gizmo.Example").ok).toBe(false);
    expect(validateOrganizationDomain("nodot").ok).toBe(false);
  });
});

describe("the activity vocabulary twins the SQL enum", () => {
  it("knows exactly the four kinds", () => {
    expect([...ACTIVITY_TYPES]).toEqual(["call", "email", "meeting", "note"]);
  });

  it("refuses anything else, so a crafted type never reaches the database", () => {
    expect(isActivityType("call")).toBe(true);
    expect(isActivityType("carrier-pigeon")).toBe(false);
    expect(isActivityType("")).toBe(false);
  });
});
