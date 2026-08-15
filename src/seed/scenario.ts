// The scenario plan — single source of truth for the seed runner
// (scripts/seed.ts) AND the isolation proof's expected exact counts
// (test/isolation.test.ts). Pure and deterministic: no I/O, no clock, no
// randomness beyond the fixed-seed PRNG below. Dates are day-offsets the
// runner resolves against seed time, so trails are never stale.
//
// Everything here is SYNTHETIC BY CONSTRUCTION (track law 4): company and
// person names are clearly fictional; every email lives under .example
// (RFC 2606 reserved — undeliverable by definition).
//
// The four demo scenarios this plan is built to (00-CONTEXT / CLAUDE.md):
//   1. Pipeline walkthrough  — wumpus-widgets: deals in every stage,
//      recent won AND lost, activity trails on every mid-pipeline deal.
//   2. Day-in-the-life       — headroom everywhere: pickable orgs/people/
//      deals, sensible defaults; nothing depends on table emptiness.
//   3. Manager view          — deliberately uneven stage distribution, a
//      visible win/loss ratio, and an activity spike (Riley, last 3 days).
//   4. Admin                 — active + deactivated users across roles;
//      Sam Farrow is the standing pending role-change to perform live.
//   (+ the isolation beat: bandersnatch-freight is a full second world.)

import { advancePath, type DealStage } from "../domain/stages";
import type { MemberRole } from "../domain/roles";

// ------------------------------------------------------------ prng

/** mulberry32 — tiny deterministic PRNG; same seed, same scenario. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pickInt = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

// ------------------------------------------------------------ plan types

export type SeedUser = {
  key: string;
  displayName: string;
  role: MemberRole;
  active: boolean;
  email: string;
  password: string;
};

export type SeedOrg = {
  name: string;
  domain: string;
  industry: string;
  city: string;
  /** key of the user who enters the org (created_by must be the author) */
  authorKey: string;
};

export type SeedPerson = {
  orgIndex: number;
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  authorKey: string;
};

export type SeedDeal = {
  name: string;
  orgIndex: number;
  ownerKey: string;
  amount: number;
  targetStage: DealStage;
  /** for lost deals: the open stage the deal died from */
  lostFrom?: DealStage;
  /** the audited-reopen demo beat: won → reopen → won again */
  reopened?: boolean;
};

export type SeedActivity = {
  type: "call" | "email" | "meeting" | "note";
  subject: string;
  daysAgo: number;
  authorKey: string;
  orgIndex?: number;
  personIndex?: number;
  dealIndex?: number;
};

export type TenantExpectations = {
  organizations: number;
  people: number;
  deals: number;
  activities: number;
  memberships: number;
  auditRows: number;
  dealsByStage: Record<DealStage, number>;
};

export type TenantPlan = {
  slug: string;
  name: string;
  users: SeedUser[];
  orgs: SeedOrg[];
  people: SeedPerson[];
  deals: SeedDeal[];
  activities: SeedActivity[];
  expected: TenantExpectations;
};

export type ScenarioPlan = { tenants: TenantPlan[] };

// ------------------------------------------------------------ name pools

const FIRST_NAMES = [
  "Avery", "Blair", "Cameron", "Devon", "Ellis", "Finley", "Greer",
  "Harper", "Indigo", "Jules", "Kendall", "Lane", "Marlowe", "Noor",
  "Oakley", "Parker", "Quinn", "Rowan", "Sage", "Tatum", "Umber", "Vale",
  "Winter", "Zephyr",
];

const LAST_NAMES = [
  "Abernathy", "Birchwood", "Cobblepot", "Dovetail", "Everhart", "Fernsby",
  "Gadsby", "Hawthorne", "Inkwell", "Jubilee", "Kettleworth", "Larkspur",
  "Mossgrove", "Nettlefold", "Oldbuck", "Pumpernickel", "Quillfeather",
  "Rambleton", "Silverspoon", "Thistledown", "Underbough", "Vexley",
  "Wimplewood", "Yarrowdale",
];

const TITLES = [
  "Purchasing Lead", "Operations Manager", "Founder", "Head of Facilities",
  "Procurement Analyst", "General Manager", "Plant Supervisor",
  "Office Manager", "Finance Director", "Logistics Coordinator",
];

const CITIES = [
  "Splitwhistle", "Dunmore Hollow", "Cranberry Flats", "Port Wexley",
  "Thornbury Vale", "Mistlewick", "Ferndale Crossing", "Gullwing Bay",
];

/** unique (first, last) pairs, deterministic */
const makePeopleNames = (count: number, rng: () => number) => {
  const used = new Set<string>();
  const names: { firstName: string; lastName: string }[] = [];
  while (names.length < count) {
    const firstName = FIRST_NAMES[pickInt(rng, 0, FIRST_NAMES.length - 1)]!;
    const lastName = LAST_NAMES[pickInt(rng, 0, LAST_NAMES.length - 1)]!;
    const pairKey = `${firstName} ${lastName}`;
    if (used.has(pairKey)) continue;
    used.add(pairKey);
    names.push({ firstName, lastName });
  }
  return names;
};

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ------------------------------------------------------------ builders

const LADDER: DealStage[] = ["lead", "qualified", "proposal", "negotiation"];

const stageIndex = (stage: DealStage): number => LADDER.indexOf(stage);

/**
 * Audit rows a deal's LIFECYCLE WALK writes — stage_changed per move, plus
 * the reopened row for the audited beat. Its creation is counted
 * separately (every record creation is audited since CRMDEMO-EPIC1-04);
 * this function is only about the walk.
 */
export const auditRowsForDeal = (deal: SeedDeal): number => {
  if (deal.targetStage === "lost") return stageIndex(deal.lostFrom ?? "lead") + 1;
  if (deal.targetStage === "won") return deal.reopened ? 7 : 4;
  return stageIndex(deal.targetStage);
};

/**
 * The successive stages the runner sets after inserting at `lead`.
 * "REOPEN" marks the audited-reopen RPC beat (manager act).
 */
export const dealWalk = (deal: SeedDeal): (DealStage | "REOPEN")[] => {
  const toNegotiation = advancePath("negotiation").slice(1);
  if (deal.targetStage === "won") {
    const walk: (DealStage | "REOPEN")[] = [...toNegotiation, "won"];
    if (deal.reopened) walk.push("REOPEN", "won");
    return walk;
  }
  if (deal.targetStage === "lost") {
    return [...advancePath(deal.lostFrom ?? "lead").slice(1), "lost"];
  }
  return advancePath(deal.targetStage).slice(1);
};

type TenantSpec = {
  slug: string;
  name: string;
  users: Omit<SeedUser, "email" | "password">[];
  orgNames: string[];
  industries: string[];
  peopleCount: number;
  /** [stage or lost-from marker, ownerKey] rows, in order */
  dealSpecs: { target: DealStage; lostFrom?: DealStage; owner: string; reopened?: boolean }[];
  dealProducts: string[];
  midActivityBase: number;
  miscNotes: { author: string; count: number }[];
  spike?: { author: string; count: number };
  rngSeed: number;
};

const buildTenant = (spec: TenantSpec): TenantPlan => {
  const rng = mulberry32(spec.rngSeed);

  const users: SeedUser[] = spec.users.map((u) => ({
    ...u,
    email: `${u.key}@${spec.slug}.example`,
    password: `demo-${spec.slug}-${u.key}`,
  }));
  const activeAuthorKeys = users.filter((u) => u.active).map((u) => u.key);

  const orgs: SeedOrg[] = spec.orgNames.map((name, i) => ({
    name,
    domain: `${slugify(name)}.example`,
    industry: spec.industries[i % spec.industries.length]!,
    city: CITIES[pickInt(rng, 0, CITIES.length - 1)]!,
    authorKey: activeAuthorKeys[i % activeAuthorKeys.length]!,
  }));

  const personNames = makePeopleNames(spec.peopleCount, rng);
  const people: SeedPerson[] = personNames.map((n, i) => {
    const orgIndex = i % orgs.length;
    return {
      orgIndex,
      firstName: n.firstName,
      lastName: n.lastName,
      email: `${n.firstName.toLowerCase()}.${n.lastName.toLowerCase()}@${orgs[orgIndex]!.domain}`,
      title: TITLES[pickInt(rng, 0, TITLES.length - 1)]!,
      authorKey: activeAuthorKeys[i % activeAuthorKeys.length]!,
    };
  });

  const deals: SeedDeal[] = spec.dealSpecs.map((d, i) => {
    const orgIndex = i % orgs.length;
    return {
      name: `${spec.orgNames[orgIndex]} — ${spec.dealProducts[i % spec.dealProducts.length]}`,
      orgIndex,
      ownerKey: d.owner,
      amount: pickInt(rng, 4, 90) * 500,
      targetStage: d.target,
      lostFrom: d.lostFrom,
      reopened: d.reopened,
    };
  });

  // activity trails on every mid-pipeline deal (qualified / proposal /
  // negotiation) — plausible, dated inside the last three weeks
  const activities: SeedActivity[] = [];
  const trailTypes: SeedActivity["type"][] = ["call", "email", "meeting", "note"];
  const trailSubjects: Record<SeedActivity["type"], string> = {
    call: "Discovery call",
    email: "Sent follow-up summary",
    meeting: "Walkthrough meeting",
    note: "Next-step notes",
  };
  deals.forEach((deal, dealIndex) => {
    if (!["qualified", "proposal", "negotiation"].includes(deal.targetStage)) return;
    const count = spec.midActivityBase + (dealIndex % 3);
    for (let j = 0; j < count; j++) {
      const type = trailTypes[(dealIndex + j) % trailTypes.length]!;
      const personIndex = people.findIndex((p) => p.orgIndex === deal.orgIndex);
      activities.push({
        type,
        subject: `${trailSubjects[type]} — ${deal.name}`,
        daysAgo: 2 + ((j * 3 + dealIndex) % 19),
        authorKey: deal.ownerKey,
        orgIndex: deal.orgIndex,
        personIndex: personIndex >= 0 ? personIndex : undefined,
        dealIndex,
      });
    }
  });

  // scattered org-level notes (day-in-the-life texture)
  spec.miscNotes.forEach((m, k) => {
    for (let j = 0; j < m.count; j++) {
      const orgIndex = (j * 3 + k) % orgs.length;
      activities.push({
        type: "note",
        subject: `Account note — ${orgs[orgIndex]!.name}`,
        daysAgo: 5 + ((j * 7 + k * 3) % 35),
        authorKey: m.author,
        orgIndex,
      });
    }
  });

  // the manager-view activity spike: one rep, last 3 days
  if (spec.spike) {
    for (let j = 0; j < spec.spike.count; j++) {
      const orgIndex = j % orgs.length;
      const personIndex = people.findIndex((p) => p.orgIndex === orgIndex);
      activities.push({
        type: j % 2 === 0 ? "call" : "note",
        subject: `Blitz outreach — ${orgs[orgIndex]!.name}`,
        daysAgo: j % 3,
        authorKey: spec.spike.author,
        orgIndex,
        personIndex: personIndex >= 0 ? personIndex : undefined,
      });
    }
  }

  const dealsByStage = Object.fromEntries(
    (["lead", "qualified", "proposal", "negotiation", "won", "lost"] as DealStage[]).map(
      (s) => [s, deals.filter((d) => d.targetStage === s).length],
    ),
  ) as Record<DealStage, number>;

  // Since CRMDEMO-EPIC1-04 the database audits ordinary record writes too
  // (migration 20260814120005), so a seeded tenant's audit trail is one row
  // per record created PLUS the stage walk. Memberships are provisioned by
  // the service role rather than administered, and carry no audit row.
  const creationRows = orgs.length + people.length + deals.length + activities.length;
  const walkRows = deals.reduce((sum, d) => sum + auditRowsForDeal(d), 0);

  return {
    slug: spec.slug,
    name: spec.name,
    users,
    orgs,
    people,
    deals,
    activities,
    expected: {
      organizations: orgs.length,
      people: people.length,
      deals: deals.length,
      activities: activities.length,
      memberships: users.length,
      auditRows: creationRows + walkRows,
      dealsByStage,
    },
  };
};

// ------------------------------------------------------------ the three tenants

const WUMPUS: TenantSpec = {
  slug: "wumpus-widgets",
  name: "Wumpus Widgets Ltd",
  rngSeed: 20260722,
  users: [
    { key: "ada",    displayName: "Ada Quill",       role: "admin",   active: true },
    { key: "morgan", displayName: "Morgan Tinsel",   role: "manager", active: true },
    { key: "riley",  displayName: "Riley Cogsworth", role: "rep",     active: true },
    { key: "sam",    displayName: "Sam Farrow",      role: "rep",     active: true },
    { key: "dana",   displayName: "Dana Wick",       role: "rep",     active: false },
    { key: "casey",  displayName: "Casey Bramble",   role: "manager", active: false },
  ],
  orgNames: [
    "Gizmo Garden Supply", "Cogwheel & Daughters", "Bumbleforth Logistics",
    "Petrichor Brewing Co", "Snickelway Books", "Marzipan Dynamics",
    "Quibble & Sprocket", "Hollowbrook Farms", "Tessellate Studios",
    "Nimbus Kite Works", "Copperkettle Cafes", "Wanderlark Travel",
    "Fiddlehead Robotics", "Glimmerfen Optics",
  ],
  industries: [
    "Retail", "Manufacturing", "Logistics", "Food & Beverage", "Media",
    "Robotics", "Agriculture", "Design", "Hospitality", "Travel",
  ],
  peopleCount: 32,
  dealSpecs: [
    { target: "lead", owner: "riley" },
    { target: "lead", owner: "sam" },
    { target: "lead", owner: "riley" },
    { target: "lead", owner: "sam" },
    { target: "lead", owner: "morgan" },
    { target: "lead", owner: "riley" },
    { target: "qualified", owner: "riley" },
    { target: "qualified", owner: "sam" },
    { target: "qualified", owner: "riley" },
    { target: "qualified", owner: "morgan" },
    { target: "proposal", owner: "riley" },
    { target: "proposal", owner: "sam" },
    { target: "proposal", owner: "riley" },
    { target: "negotiation", owner: "sam" },
    { target: "negotiation", owner: "riley" },
    { target: "won", owner: "riley", reopened: true }, // the audited-reopen beat
    { target: "won", owner: "sam" },
    { target: "won", owner: "riley" },
    { target: "won", owner: "morgan" },
    { target: "lost", owner: "riley", lostFrom: "qualified" },
    { target: "lost", owner: "sam", lostFrom: "proposal" },
    { target: "lost", owner: "riley", lostFrom: "negotiation" },
  ],
  dealProducts: [
    "Widget Refresh Q3", "Sprocket Retrofit", "Gadget Fleet Upgrade",
    "Annual Widget Care", "Prototype Run", "Assembly Line Tune",
    "Custom Cog Order", "Doohickey Pilot",
  ],
  midActivityBase: 3,
  miscNotes: [
    { author: "ada", count: 2 },
    { author: "morgan", count: 2 },
    { author: "sam", count: 2 },
  ],
  spike: { author: "riley", count: 8 },
};

const BANDERSNATCH: TenantSpec = {
  slug: "bandersnatch-freight",
  name: "Bandersnatch Freight Co",
  rngSeed: 84920117,
  users: [
    { key: "abe",  displayName: "Abe Ledger",      role: "admin",   active: true },
    { key: "mira", displayName: "Mira Slate",      role: "manager", active: true },
    { key: "rosa", displayName: "Rosa Pennyworth", role: "rep",     active: true },
    { key: "theo", displayName: "Theo Marsh",      role: "rep",     active: false },
  ],
  orgNames: [
    "Ironclad Anchors", "Saltmarsh Exports", "Pinwheel Confections",
    "Grumble & Sons Salvage", "Larkspur Line Railway", "Mistral Sails",
    "Ochre Quarry Co", "Tumbledown Timber",
  ],
  industries: [
    "Maritime", "Export", "Confectionery", "Salvage", "Rail", "Textiles",
    "Mining", "Timber",
  ],
  peopleCount: 18,
  dealSpecs: [
    { target: "lead", owner: "rosa" },
    { target: "lead", owner: "rosa" },
    { target: "lead", owner: "mira" },
    { target: "qualified", owner: "rosa" },
    { target: "qualified", owner: "rosa" },
    { target: "qualified", owner: "mira" },
    { target: "proposal", owner: "rosa" },
    { target: "proposal", owner: "mira" },
    { target: "negotiation", owner: "rosa" },
    { target: "negotiation", owner: "rosa" },
    { target: "won", owner: "rosa" },
    { target: "won", owner: "mira" },
    { target: "lost", owner: "rosa", lostFrom: "proposal" },
  ],
  dealProducts: [
    "Coastal Route Contract", "Bulk Haulage Deal", "Cold Chain Pilot",
    "Seasonal Freight Block", "Depot Handling Agreement",
  ],
  midActivityBase: 3,
  miscNotes: [
    { author: "abe", count: 2 },
    { author: "rosa", count: 2 },
  ],
};

const MOONRISE: TenantSpec = {
  slug: "moonrise-cheeseworks",
  name: "Moonrise Cheeseworks",
  rngSeed: 55107,
  users: [
    { key: "ana",   displayName: "Ana Rind",    role: "admin",   active: true },
    { key: "marco", displayName: "Marco Curd",  role: "manager", active: true },
    { key: "remy",  displayName: "Remy Wheel",  role: "rep",     active: true },
    { key: "lou",   displayName: "Lou Brine",   role: "rep",     active: false },
  ],
  orgNames: ["Thistle & Rind Market", "Brindle Bistro Group", "Alpenglow Grocers"],
  industries: ["Grocery", "Hospitality", "Retail"],
  peopleCount: 6,
  dealSpecs: [
    { target: "lead", owner: "remy" },
    { target: "lead", owner: "remy" },
    { target: "qualified", owner: "remy" },
  ],
  dealProducts: ["Wholesale Wheel Order", "Tasting Room Program", "Cave-Aged Reserve Lot"],
  midActivityBase: 3,
  miscNotes: [{ author: "ana", count: 2 }],
};

export const buildScenario = (): ScenarioPlan => ({
  tenants: [buildTenant(WUMPUS), buildTenant(BANDERSNATCH), buildTenant(MOONRISE)],
});

/** the standing pending role-change of the admin demo scenario */
export const PENDING_ROLE_CHANGE = {
  tenantSlug: "wumpus-widgets",
  userKey: "sam",
  from: "rep",
  to: "manager",
} as const;
