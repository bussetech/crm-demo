// THE WRITE PROOF (CRMDEMO-EPIC1-04) — the third stack-backed gate.
//
// test/isolation.test.ts proves RLS at the row level; test/routes.test.ts
// proves the same law in the bytes of a rendered page. Both are READS, and
// both are read-only on purpose. This one writes.
//
// It walks the day-in-the-life scenario through the REAL WORKER, as a real
// rep, with real form posts — add an organization, add a contact, log a
// call, advance a deal, close it won — and then reads the audit trail back
// as the tenant admin and finds every step in it. Around that walk it
// pins the capability table (role × action → allowed / refused) and the
// invariants: a crafted illegal transition is refused BY THE DATABASE, a
// cross-tenant id writes nothing, a rep cannot touch another rep's book.
//
// IT MUTATES, so it runs LAST — after the two exact-count proofs, which
// must meet the seeded baseline untouched (scripts/run-isolation.sh runs
// the three in order; `npm run db:rebuild` is the one command). Its own
// assertions are deltas against a baseline it measures at start, never
// absolute counts, so it does not care what ran before it.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { app } from "../src/index";
import type { Env } from "../src/env";
import { buildScenario, type SeedUser, type TenantPlan } from "../src/seed/scenario";
import { ACTIVITY_BODY_MAX } from "../src/domain/validation";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] ?? "";
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("run via scripts/run-isolation.sh (bridges the local stack env)");
}

const env: Env = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  APP_BUILD_ID: "test-crmdemo-04",
};

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const plan = buildScenario();
const wumpus = plan.tenants[0]!;
const bandersnatch = plan.tenants[1]!;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// ------------------------------------------------------------ harness

const userOf = (tenant: TenantPlan, key: string): SeedUser => {
  const user = tenant.users.find((u) => u.key === key);
  if (!user) throw new Error(`no seeded user ${tenant.slug}/${key}`);
  return user;
};

const get = async (path: string, cookie?: string): Promise<Response> =>
  app.request(path, cookie ? { headers: { cookie } } : {}, env);

const post = async (
  path: string,
  fields: Record<string, string>,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> =>
  app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );

/** Signs in THROUGH THE APP's own login route and returns its cookie header. */
async function signIn(user: SeedUser): Promise<string> {
  const res = await post("/login", { email: user.email, password: user.password });
  expect(res.status, `login ${user.email} -> ${res.status}`).toBe(303);
  const pairs = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean);
  expect(pairs.length, `login ${user.email} set no cookies`).toBeGreaterThan(0);
  return pairs.join("; ");
}

const sessions = new Map<string, string>();
const userIds = new Map<string, string>(); // display name -> auth user id
const tenantIds = new Map<string, string>();

const cookieOf = (tenant: TenantPlan, key: string): string => {
  const cookie = sessions.get(`${tenant.slug}/${key}`);
  if (!cookie) throw new Error(`no session for ${tenant.slug}/${key}`);
  return cookie;
};

const idOf = (tenant: TenantPlan, key: string): string => {
  const id = userIds.get(userOf(tenant, key).displayName);
  if (!id) throw new Error(`no auth id for ${tenant.slug}/${key}`);
  return id;
};

/** The id a 303 redirect points at — how every create hands back its row. */
const createdId = (res: Response, prefix: string): string => {
  const location = res.headers.get("location") ?? "";
  expect(location, `expected a redirect under ${prefix}, got "${location}"`).toContain(prefix);
  const match = location.match(UUID_RE);
  expect(match, `no id in redirect "${location}"`).toBeTruthy();
  return match![0];
};

const escHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Audit rows for one entity, service-side — what the trail REALLY holds. */
const auditFor = async (entityId: string): Promise<{ action: string; detail: Record<string, unknown>; actor_id: string }[]> => {
  const { data, error } = await service
    .from("audit_log")
    .select("action, detail, actor_id")
    .eq("entity_id", entityId)
    .order("id");
  expect(error).toBeNull();
  return (data ?? []) as { action: string; detail: Record<string, unknown>; actor_id: string }[];
};

const auditCount = async (tenantSlug: string): Promise<number> => {
  const { count, error } = await service
    .from("audit_log")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantIds.get(tenantSlug)!);
  expect(error).toBeNull();
  return count ?? 0;
};

const dealById = async (id: string) => {
  const { data, error } = await service
    .from("deals")
    .select("id, name, amount, stage, owner_id, closed_at, org_id")
    .eq("id", id)
    .single();
  expect(error).toBeNull();
  return data!;
};

const dealIdByName = new Map<string, string>();
const orgIdByName = new Map<string, string>();

beforeAll(async () => {
  const { data: tenants } = await service.from("tenants").select("id, slug");
  expect((tenants ?? []).length, "stack is not seeded — run `npm run db:rebuild`").toBe(
    plan.tenants.length,
  );
  for (const t of (tenants ?? []) as { id: string; slug: string }[]) tenantIds.set(t.slug, t.id);

  const { data: members } = await service.from("memberships").select("user_id, display_name");
  for (const m of (members ?? []) as { user_id: string; display_name: string }[]) {
    userIds.set(m.display_name, m.user_id);
  }

  for (const tenant of plan.tenants) {
    for (const user of tenant.users.filter((u) => u.active)) {
      sessions.set(`${tenant.slug}/${user.key}`, await signIn(user));
    }
  }

  const { data: deals } = await service.from("deals").select("id, name");
  for (const d of (deals ?? []) as { id: string; name: string }[]) dealIdByName.set(d.name, d.id);
  const { data: orgs } = await service.from("organizations").select("id, name");
  for (const o of (orgs ?? []) as { id: string; name: string }[]) orgIdByName.set(o.name, o.id);
}, 120_000);

// ------------------------------------------------------------ the walk
//
// Names are marked WALK- so they cannot collide with the scenario plan and
// so a human poking at the stack afterwards can see what the proof left.

const WALK = {
  org: "WALK Thimbleforge Metalworks",
  person: { first: "Wren", last: "Bellowsby" },
  activity: "WALK Discovery call with Wren",
  deal: "WALK Thimbleforge — Bellows Retrofit",
};

const walk: { orgId?: string; personId?: string; dealId?: string; baseline?: number } = {};

describe("the day-in-the-life walk, end to end, as a rep", () => {
  it("starts from a measured baseline", async () => {
    walk.baseline = await auditCount(wumpus.slug);
    expect(walk.baseline).toBeGreaterThan(0);
  });

  it("a rep adds an organization", async () => {
    const res = await post(
      "/organizations",
      {
        name: WALK.org,
        domain: "thimbleforge.example",
        industry: "Manufacturing",
        city: "Splitwhistle",
      },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(303);
    walk.orgId = createdId(res, "/organizations/");

    const html = await (await get(`/organizations/${walk.orgId}?saved=created`, cookieOf(wumpus, "riley"))).text();
    expect(html).toContain(escHtml(WALK.org));
    expect(html).toContain("Created.");
  });

  it("…and the database audited it, once, against the rep", async () => {
    const rows = await auditFor(walk.orgId!);
    expect(rows.map((r) => r.action)).toEqual(["organization.created"]);
    expect(rows[0]!.actor_id).toBe(idOf(wumpus, "riley"));
    expect(rows[0]!.detail["name"]).toBe(WALK.org);
  });

  it("a rep adds a contact at that organization", async () => {
    const res = await post(
      "/people",
      {
        firstName: WALK.person.first,
        lastName: WALK.person.last,
        orgId: walk.orgId!,
        email: "wren.bellowsby@thimbleforge.example",
        title: "Plant Supervisor",
        phone: "",
      },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(303);
    walk.personId = createdId(res, "/people/");

    const rows = await auditFor(walk.personId!);
    expect(rows.map((r) => r.action)).toEqual(["person.created"]);
    expect(rows[0]!.detail["name"]).toBe(`${WALK.person.first} ${WALK.person.last}`);
  });

  it("a rep logs a call against the organization and the contact", async () => {
    const res = await post(
      "/activities",
      {
        type: "call",
        subject: WALK.activity,
        body: "Walked the shop floor. They want a quote on the bellows line.",
        orgId: walk.orgId!,
        personId: walk.personId!,
        dealId: "",
      },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(303);
    // logged against a person → back to the person, where the trail shows it
    expect(res.headers.get("location")).toBe(`/people/${walk.personId}?saved=logged`);

    const html = await (await get(`/people/${walk.personId}`, cookieOf(wumpus, "riley"))).text();
    expect(html).toContain(escHtml(WALK.activity));
  });

  it("a rep opens a deal — born at Lead, whatever anyone asks for", async () => {
    const res = await post(
      "/deals",
      {
        name: WALK.deal,
        amount: "18500",
        orgId: walk.orgId!,
        ownerId: idOf(wumpus, "riley"),
      },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(303);
    walk.dealId = createdId(res, "/deals/");

    const deal = await dealById(walk.dealId!);
    expect(deal.stage).toBe("lead");
    expect(deal.closed_at).toBeNull();
    expect(Number(deal.amount)).toBe(18500);
    expect(deal.owner_id).toBe(idOf(wumpus, "riley"));
  });

  it("a rep walks it up the pipeline and closes it won", async () => {
    const cookie = cookieOf(wumpus, "riley");
    for (const stage of ["qualified", "proposal", "negotiation", "won"]) {
      const res = await post(`/deals/${walk.dealId}/stage`, { stage }, cookie);
      expect(res.status, `move to ${stage}`).toBe(303);
      expect(res.headers.get("location")).toBe(`/deals/${walk.dealId}?saved=stage`);
      expect((await dealById(walk.dealId!)).stage).toBe(stage);
    }
    const closed = await dealById(walk.dealId!);
    expect(closed.closed_at, "won deals carry a close stamp, trigger-maintained").not.toBeNull();
  });

  it("the audit trail holds every step of the walk, in order", async () => {
    const rows = await auditFor(walk.dealId!);
    expect(rows.map((r) => r.action)).toEqual([
      "deal.created",
      "deal.stage_changed",
      "deal.stage_changed",
      "deal.stage_changed",
      "deal.stage_changed",
    ]);
    expect(rows.map((r) => `${r.detail["from"] ?? "-"}>${r.detail["to"] ?? "-"}`)).toEqual([
      "->-",
      "lead>qualified",
      "qualified>proposal",
      "proposal>negotiation",
      "negotiation>won",
    ]);
    for (const row of rows) expect(row.actor_id).toBe(idOf(wumpus, "riley"));
  });

  it("the whole walk added exactly the rows it should have — nothing extra, nothing lost", async () => {
    // org + person + activity + deal + four moves
    expect(await auditCount(wumpus.slug)).toBe(walk.baseline! + 8);
  });

  it("the tenant admin sees every step on the audit page", async () => {
    const html = await (await get("/audit", cookieOf(wumpus, "ada"))).text();
    expect(html).toContain("Organization added");
    expect(html).toContain("Person added");
    expect(html).toContain("Call logged");
    expect(html).toContain("Deal created at Lead");
    expect(html).toContain("Negotiation → Won");
    expect(html).toContain(escHtml(WALK.org));
    expect(html).toContain(escHtml(WALK.deal));
    // and the trail names who did it
    expect(html).toContain("Riley Cogsworth");
  });

  it("the deal's own page shows its full history to the admin", async () => {
    const html = await (await get(`/deals/${walk.dealId}`, cookieOf(wumpus, "ada"))).text();
    expect(html).toContain("Deal history");
    expect(html).toContain("Deal created at Lead");
    expect(html).toContain("Lead → Qualified");
    expect(html).toContain("Negotiation → Won");
  });
});

// ------------------------------------------------------------ audit visibility

describe("the audit trail is admin-eyes-only, and says so honestly", () => {
  it.each([
    ["manager", "morgan"],
    ["rep", "riley"],
  ])("a %s is given nothing by the database, and the page says which", async (_role, key) => {
    const html = await (await get("/audit", cookieOf(wumpus, key))).text();
    expect(html).toContain("tenant admins only");
    // the query DID run under their sign-in; it returned no rows
    expect(html).not.toContain("Deal created at Lead");
    expect(html).not.toContain(escHtml(WALK.deal));
  });

  it("the audit link is not even offered to a non-admin", async () => {
    const admin = await (await get("/", cookieOf(wumpus, "ada"))).text();
    const rep = await (await get("/", cookieOf(wumpus, "riley"))).text();
    expect(admin).toContain('href="/audit"');
    expect(rep).not.toContain('href="/audit"');
  });

  it("but hiding the link is not what protects it — the page is reachable and empty", async () => {
    const res = await get("/audit", cookieOf(wumpus, "riley"));
    expect(res.status).toBe(200);
  });
});

// ------------------------------------------------------------ capability table

describe("capability: what each role may write", () => {
  it("a manager may open a deal for someone else's book", async () => {
    const res = await post(
      "/deals",
      {
        name: "WALK Manager-assigned deal",
        amount: "2000",
        orgId: walk.orgId!,
        ownerId: idOf(wumpus, "sam"),
      },
      cookieOf(wumpus, "morgan"),
    );
    expect(res.status).toBe(303);
    const deal = await dealById(createdId(res, "/deals/"));
    expect(deal.owner_id).toBe(idOf(wumpus, "sam"));
  });

  it("a rep may NOT — the INSERT policy refuses the owner, not this app", async () => {
    const name = "WALK Rep-assigned to someone else";
    const res = await post(
      "/deals",
      { name, amount: "2000", orgId: walk.orgId!, ownerId: idOf(wumpus, "sam") },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    const { data } = await service.from("deals").select("id").eq("name", name);
    expect(data, "the refused deal must not exist").toHaveLength(0);
  });

  it("a rep sees no owner picker at all — the form matches what the policy allows", async () => {
    const repForm = await (await get("/deals/new", cookieOf(wumpus, "riley"))).text();
    const mgrForm = await (await get("/deals/new", cookieOf(wumpus, "morgan"))).text();
    expect(repForm).not.toContain('<select id="ownerId"');
    expect(repForm).toContain("Riley Cogsworth");
    expect(mgrForm).toContain('<select id="ownerId"');
  });

  it("a rep may edit their own deal", async () => {
    const res = await post(
      `/deals/${walk.dealId}`,
      { name: WALK.deal, amount: "19500", ownerId: idOf(wumpus, "riley") },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(303);
    expect(Number((await dealById(walk.dealId!)).amount)).toBe(19500);
    const actions = (await auditFor(walk.dealId!)).map((r) => r.action);
    expect(actions).toContain("deal.updated");
  });

  it("a rep may NOT edit another rep's deal — zero rows, no oracle", async () => {
    const samWon = wumpus.deals.find((d) => d.ownerKey === "sam" && d.targetStage === "won")!;
    const dealId = dealIdByName.get(samWon.name)!;
    const before = await dealById(dealId);

    const res = await post(
      `/deals/${dealId}`,
      { name: "WALK hijacked", amount: "1", ownerId: idOf(wumpus, "riley") },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Nothing changed");
    // it must not confirm that the deal exists
    expect(html).not.toContain(escHtml(samWon.name));

    const after = await dealById(dealId);
    expect(after.name).toBe(before.name);
    expect(Number(after.amount)).toBe(Number(before.amount));
    expect(after.owner_id).toBe(before.owner_id);
  });

  it("…and is not offered the form for it either", async () => {
    const samWon = wumpus.deals.find((d) => d.ownerKey === "sam" && d.targetStage === "won")!;
    const res = await get(`/deals/${dealIdByName.get(samWon.name)}/edit`, cookieOf(wumpus, "riley"));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Not yours to change");
  });

  it("a rep may not move another rep's deal", async () => {
    const samLead = wumpus.deals.find((d) => d.ownerKey === "sam" && d.targetStage === "lead")!;
    const dealId = dealIdByName.get(samLead.name)!;
    const res = await post(`/deals/${dealId}/stage`, { stage: "qualified" }, cookieOf(wumpus, "riley"));
    expect(res.status).toBe(404);
    expect((await dealById(dealId)).stage).toBe("lead");
  });

  it("a manager may move anyone's deal", async () => {
    const samLead = wumpus.deals.find((d) => d.ownerKey === "sam" && d.targetStage === "lead")!;
    const dealId = dealIdByName.get(samLead.name)!;
    const res = await post(`/deals/${dealId}/stage`, { stage: "qualified" }, cookieOf(wumpus, "morgan"));
    expect(res.status).toBe(303);
    expect((await dealById(dealId)).stage).toBe("qualified");
  });

  it("every active member may add organizations, contacts and activity", async () => {
    for (const key of ["ada", "morgan", "riley", "sam"]) {
      const res = await post(
        "/organizations",
        { name: `WALK Org by ${key}`, domain: "", industry: "", city: "" },
        cookieOf(wumpus, key),
      );
      expect(res.status, `${key} creating an organization`).toBe(303);
    }
  });
});

// ------------------------------------------------------------ reopen

describe("the audited reopen is the only exit from a closed deal", () => {
  it("a rep is refused, in the RPC's own words", async () => {
    const res = await post(
      `/deals/${walk.dealId}/reopen`,
      { reason: "I would like it back" },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires role admin or manager");
    expect((await dealById(walk.dealId!)).stage).toBe("won");
  });

  it("a manager is refused without a reason, before the database is even asked", async () => {
    const res = await post(`/deals/${walk.dealId}/reopen`, { reason: "   " }, cookieOf(wumpus, "morgan"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("reason");
    expect((await dealById(walk.dealId!)).stage).toBe("won");
  });

  it("a manager with a reason reopens it — to Negotiation, audited, uncosed", async () => {
    const reason = "WALK Customer asked to revisit the bellows spec";
    const res = await post(`/deals/${walk.dealId}/reopen`, { reason }, cookieOf(wumpus, "morgan"));
    expect(res.status).toBe(303);

    const deal = await dealById(walk.dealId!);
    expect(deal.stage).toBe("negotiation");
    expect(deal.closed_at, "reopening clears the close stamp").toBeNull();

    const rows = await auditFor(walk.dealId!);
    const reopened = rows.filter((r) => r.action === "deal.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.detail["reason"]).toBe(reason);
    expect(reopened[0]!.actor_id).toBe(idOf(wumpus, "morgan"));
  });

  it("the reason reaches the admin's audit page verbatim", async () => {
    const html = await (await get("/audit", cookieOf(wumpus, "ada"))).text();
    expect(html).toContain("WALK Customer asked to revisit the bellows spec");
    expect(html).toContain("Morgan Tinsel");
  });

  it("the deal page offers the reopen form to a manager and not to the owner", async () => {
    // put it back to won first, so the terminal-stage surface is the one under test
    expect((await post(`/deals/${walk.dealId}/stage`, { stage: "won" }, cookieOf(wumpus, "morgan"))).status).toBe(303);

    const mgr = await (await get(`/deals/${walk.dealId}`, cookieOf(wumpus, "morgan"))).text();
    expect(mgr).toContain('action="/deals/' + walk.dealId + '/reopen"');
    expect(mgr).toContain("yours is one of them");

    const rep = await (await get(`/deals/${walk.dealId}`, cookieOf(wumpus, "riley"))).text();
    expect(rep).not.toContain("/reopen");
    expect(rep).toContain("not one of them");
  });
});

// ------------------------------------------------------------ invariants

describe("invariants the DATABASE holds, not the form", () => {
  it("a crafted illegal transition is refused by the database", async () => {
    // a fresh deal at lead; lead → won is illegal (won only from negotiation)
    const created = await post(
      "/deals",
      { name: "WALK Crafted-transition deal", amount: "100", orgId: walk.orgId!, ownerId: idOf(wumpus, "riley") },
      cookieOf(wumpus, "riley"),
    );
    const dealId = createdId(created, "/deals/");

    const res = await post(`/deals/${dealId}/stage`, { stage: "won" }, cookieOf(wumpus, "riley"));
    expect(res.status).toBe(400);
    // the refusal is the TRIGGER's, quoted — not a message this app invented
    expect(await res.text()).toContain("illegal stage transition");
    expect((await dealById(dealId)).stage).toBe("lead");

    // and no audit row was written for a move that never happened
    expect((await auditFor(dealId)).map((r) => r.action)).toEqual(["deal.created"]);
  });

  it("the form never offers the move the database would refuse", async () => {
    const html = await (await get(`/deals/${dealIdByName.get(wumpus.deals[0]!.name)}`, cookieOf(wumpus, "riley"))).text();
    // a lead-stage deal's control offers qualified/proposal/negotiation/lost
    expect(html).toContain('<option value="qualified">');
    expect(html).toContain('<option value="lost">');
    expect(html).not.toContain('<option value="won">');
  });

  it("a stage outside the vocabulary never reaches the database", async () => {
    const dealId = dealIdByName.get(wumpus.deals[0]!.name)!;
    const before = (await dealById(dealId)).stage;
    const res = await post(`/deals/${dealId}/stage`, { stage: "shipped" }, cookieOf(wumpus, "riley"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not a stage this pipeline has");
    expect((await dealById(dealId)).stage).toBe(before);
  });

  it("a cross-tenant organization id writes nothing and says nothing", async () => {
    const foreignId = orgIdByName.get(bandersnatch.orgs[0]!.name)!;
    const res = await post(
      `/organizations/${foreignId}`,
      { name: "WALK cross-tenant overwrite", domain: "", industry: "", city: "" },
      cookieOf(wumpus, "ada"),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(escHtml(bandersnatch.orgs[0]!.name));

    const { data } = await service.from("organizations").select("name").eq("id", foreignId).single();
    expect(data!.name).toBe(bandersnatch.orgs[0]!.name);
  });

  it("a cross-tenant deal cannot be moved", async () => {
    const foreignId = dealIdByName.get(bandersnatch.deals[0]!.name)!;
    const before = await dealById(foreignId);
    const res = await post(`/deals/${foreignId}/stage`, { stage: "qualified" }, cookieOf(wumpus, "ada"));
    expect(res.status).toBe(404);
    expect((await dealById(foreignId)).stage).toBe(before.stage);
  });

  it("a contact cannot be hung off another tenant's organization", async () => {
    const foreignOrg = orgIdByName.get(bandersnatch.orgs[0]!.name)!;
    const res = await post(
      "/people",
      { firstName: "WALK", lastName: "Trespasser", orgId: foreignOrg, email: "", title: "", phone: "" },
      cookieOf(wumpus, "ada"),
    );
    expect(res.status).toBe(400);
    const { data } = await service.from("people").select("id").eq("last_name", "Trespasser");
    expect(data).toHaveLength(0);
  });

  it("an activity cannot be linked across the boundary either", async () => {
    const foreignOrg = orgIdByName.get(bandersnatch.orgs[0]!.name)!;
    const subject = "WALK cross-tenant note";
    const res = await post(
      "/activities",
      { type: "note", subject, body: "", orgId: foreignOrg, personId: "", dealId: "" },
      cookieOf(wumpus, "ada"),
    );
    expect(res.status).toBe(400);
    const { data } = await service.from("activities").select("id").eq("subject", subject);
    expect(data).toHaveLength(0);
  });

  it("a deal's organization is immutable — the guard raises, at the row level", async () => {
    const dealId = walk.dealId!;
    const otherOrg = orgIdByName.get(wumpus.orgs[1]!.name)!;
    const { error } = await service.from("deals").update({ org_id: otherOrg }).eq("id", dealId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("org_id is immutable");
  });

  it("editing nothing audits nothing", async () => {
    const before = (await auditFor(walk.orgId!)).length;
    const same = { name: WALK.org, domain: "thimbleforge.example", industry: "Manufacturing", city: "Splitwhistle" };
    const res = await post(`/organizations/${walk.orgId}`, same, cookieOf(wumpus, "riley"));
    expect(res.status).toBe(303);
    expect(await auditFor(walk.orgId!)).toHaveLength(before);
  });

  it("editing something audits exactly what changed", async () => {
    const res = await post(
      `/organizations/${walk.orgId}`,
      { name: WALK.org, domain: "thimbleforge.example", industry: "Metalwork", city: "Port Wexley" },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(303);
    const rows = await auditFor(walk.orgId!);
    const edit = rows.filter((r) => r.action === "organization.updated");
    expect(edit).toHaveLength(1);
    expect(edit[0]!.detail["changed"]).toEqual(["industry", "city"]);
  });

  it("an edit moves updated_at, which read-only builds never had to prove", async () => {
    const { data } = await service
      .from("organizations")
      .select("created_at, updated_at")
      .eq("id", walk.orgId!)
      .single();
    expect(Date.parse(data!.updated_at)).toBeGreaterThan(Date.parse(data!.created_at));
  });
});

// ------------------------------------------------------------ validation

describe("validation: friendly first, database as the backstop", () => {
  it("refuses a nameless organization with a message a person can act on", async () => {
    const res = await post(
      "/organizations",
      { name: "   ", domain: "", industry: "", city: "" },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("1–120 characters");
  });

  it("refuses a URL where a domain belongs", async () => {
    const res = await post(
      "/organizations",
      { name: "WALK Bad Domain Co", domain: "https://nope.example/x", industry: "", city: "" },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("example.com");
  });

  it("refuses a negative amount", async () => {
    const res = await post(
      "/deals",
      { name: "WALK Negative", amount: "-5", orgId: walk.orgId!, ownerId: idOf(wumpus, "riley") },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("zero or positive");
  });

  it("refuses an activity that links to nothing", async () => {
    const res = await post(
      "/activities",
      { type: "note", subject: "WALK unattached", body: "", orgId: "", personId: "", dealId: "" },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("must link to an organization");
  });

  it("refuses an over-long note with a message, not a bare 413", async () => {
    const res = await post(
      "/activities",
      {
        type: "note",
        subject: "WALK long note",
        body: "x".repeat(ACTIVITY_BODY_MAX + 1),
        orgId: walk.orgId!,
        personId: "",
        dealId: "",
      },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("characters or fewer");
  });

  it("still refuses a genuinely oversized body at the door", async () => {
    const res = await app.request(
      "/activities",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "500000",
          cookie: cookieOf(wumpus, "riley"),
        },
        body: "type=note&subject=x",
      },
      env,
    );
    expect(res.status).toBe(413);
  });

  it("keeps the reader's input when it refuses, so nothing has to be retyped", async () => {
    const res = await post(
      "/organizations",
      { name: "WALK Keeps Input Co", domain: "not a domain", industry: "Robotics", city: "Mistlewick" },
      cookieOf(wumpus, "riley"),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('value="WALK Keeps Input Co"');
    expect(html).toContain('value="Robotics"');
  });
});

// ------------------------------------------------------------ the closed doors

describe("who cannot write at all", () => {
  const WRITE_ROUTES: [string, Record<string, string>][] = [
    ["/organizations", { name: "WALK anonymous org" }],
    ["/people", { firstName: "WALK", lastName: "Anonymous" }],
    ["/deals", { name: "WALK anonymous deal", amount: "1" }],
    ["/activities", { type: "note", subject: "WALK anonymous note" }],
  ];

  it.each(WRITE_ROUTES)("anonymous is sent to the login page from %s", async (path, fields) => {
    const res = await post(path, fields);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith("/login")).toBe(true);
  });

  it("and wrote nothing on the way", async () => {
    const { data } = await service.from("organizations").select("id").eq("name", "WALK anonymous org");
    expect(data).toHaveLength(0);
  });

  it("a garbage session cannot write either", async () => {
    const res = await post("/organizations", { name: "WALK forged org" }, "crm-access=not-a-jwt");
    expect(res.status).toBe(302);
    const { data } = await service.from("organizations").select("id").eq("name", "WALK forged org");
    expect(data).toHaveLength(0);
  });

  it("a deactivated member cannot get a session to write with", async () => {
    const dana = userOf(wumpus, "dana");
    const res = await post("/login", { email: dana.email, password: dana.password });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().filter((c) => /crm-access=[^;]/.test(c))).toHaveLength(0);
  });

  it("a cross-origin write is refused before it is read", async () => {
    const res = await post(
      "/organizations",
      { name: "WALK cross-origin org" },
      cookieOf(wumpus, "riley"),
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    const { data } = await service.from("organizations").select("id").eq("name", "WALK cross-origin org");
    expect(data).toHaveLength(0);
  });
});

// ------------------------------------------------------------ still isolated

describe("after all of that, the tenants are still sealed", () => {
  it("nothing this proof wrote reached another tenant", async () => {
    const { data } = await service
      .from("organizations")
      .select("name, tenant_id")
      .like("name", "WALK%");
    expect((data ?? []).length).toBeGreaterThan(0);
    for (const row of (data ?? []) as { name: string; tenant_id: string }[]) {
      expect(row.tenant_id, `${row.name} landed outside wumpus`).toBe(tenantIds.get(wumpus.slug));
    }
  });

  it("a Bandersnatch reader still sees no Wumpus writing", async () => {
    const html = await (await get("/organizations", cookieOf(bandersnatch, "abe"))).text();
    expect(html).not.toContain(escHtml(WALK.org));
    const audit = await (await get("/audit", cookieOf(bandersnatch, "abe"))).text();
    expect(audit).not.toContain(escHtml(WALK.org));
    expect(audit).not.toContain(escHtml(WALK.deal));
  });

  it("and its own audit trail is untouched by this session's work", async () => {
    const rows = await auditCount(bandersnatch.slug);
    expect(rows).toBe(bandersnatch.expected.auditRows);
  });
});
