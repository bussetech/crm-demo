// THE ROUTE PROOF — the isolation law re-asserted where a demo audience
// actually meets it: in the bytes of a rendered page.
//
// test/isolation.test.ts proves RLS at the row level. This proves the same
// property one layer up, through the real Worker: every role in every
// tenant walks every route, and a page served to Wumpus never contains a
// Bandersnatch string. A route handler that "helpfully" widened a query
// would fail here even though the database was innocent.
//
// Requires a FRESHLY SEEDED stack; runs after the isolation proof in
// scripts/run-isolation.sh (npm run db:rebuild is the one command). It is
// read-only — it signs in and reads, so it leaves the row counts the
// isolation proof asserts exactly as it found them.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { app } from "../src/index";
import type { Env } from "../src/env";
import { buildScenario, type SeedUser, type TenantPlan } from "../src/seed/scenario";
import { BANNER_TEXT } from "../src/ui/layout";
import { RESET_POSTURE, demoTenants, resetCopy } from "../src/views/demo";
import { money } from "../src/views/format";
import { OPEN_STAGES, type DealStage } from "../src/domain/stages";
import { ACTIVITY_TYPES } from "../src/domain/activity";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] ?? "";
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("run via scripts/run-isolation.sh (bridges the local stack env)");
}

/**
 * The env the Worker actually gets. Note what is NOT here: the service-role
 * key. A request path cannot reach for it because the binding does not
 * exist (stratum law, made structural).
 */
const env: Env = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  APP_BUILD_ID: "test-crmdemo-03",
};

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const plan = buildScenario();
const wumpus = plan.tenants[0]!;
const bandersnatch = plan.tenants[1]!;
const moonrise = plan.tenants[2]!;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The routes every signed-in member may reach. */
const APP_ROUTES = [
  "/",
  "/organizations",
  "/people",
  "/deals",
  "/deals/board",
  "/activities",
] as const;

const userOf = (tenant: TenantPlan, key: string): SeedUser => {
  const user = tenant.users.find((u) => u.key === key);
  if (!user) throw new Error(`no seeded user ${tenant.slug}/${key}`);
  return user;
};

const get = async (path: string, cookie?: string): Promise<Response> =>
  app.request(path, cookie ? { headers: { cookie } } : {}, env);

const postForm = async (
  path: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );

/** Signs in THROUGH THE APP's own login route and returns its cookie header. */
async function signIn(user: SeedUser): Promise<string> {
  const res = await postForm("/login", { email: user.email, password: user.password });
  expect(res.status, `login ${user.email} -> ${res.status}`).toBe(303);
  const cookies = res.headers.getSetCookie();
  const pairs = cookies.map((c) => c.split(";")[0]).filter(Boolean);
  expect(pairs.length, `login ${user.email} set no cookies`).toBeGreaterThan(0);
  return pairs.join("; ");
}

const countMatches = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

/**
 * Compare against what the page actually SAYS. Hono escapes on render, so
 * "Grumble & Sons Salvage" reaches the browser as "Grumble &amp; Sons
 * Salvage" — and a leak-detecting `not.toContain` on the raw name would
 * pass vacuously for every tenant whose orgs have an ampersand. Escape
 * first, then assert.
 */
const esc = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sessions = new Map<string, string>(); // `${slug}/${key}` -> cookie header
const dealIdByName = new Map<string, string>();
const orgIdByName = new Map<string, string>();

beforeAll(async () => {
  const { data: tenants, error: tErr } = await service.from("tenants").select("id, slug");
  expect(tErr).toBeNull();
  expect(
    (tenants ?? []).length,
    "stack is not seeded — run `npm run db:rebuild`",
  ).toBe(plan.tenants.length);

  for (const tenant of plan.tenants) {
    for (const user of tenant.users.filter((u) => u.active)) {
      sessions.set(`${tenant.slug}/${user.key}`, await signIn(user));
    }
  }

  const { data: deals } = await service.from("deals").select("id, name");
  for (const d of (deals ?? []) as { id: string; name: string }[]) {
    dealIdByName.set(d.name, d.id);
  }
  const { data: orgs } = await service.from("organizations").select("id, name");
  for (const o of (orgs ?? []) as { id: string; name: string }[]) {
    orgIdByName.set(o.name, o.id);
  }
});

const cookieOf = (tenant: TenantPlan, key: string): string => {
  const cookie = sessions.get(`${tenant.slug}/${key}`);
  if (!cookie) throw new Error(`no session for ${tenant.slug}/${key}`);
  return cookie;
};

// ------------------------------------------------------------ the public edge

describe("public surface", () => {
  it("/healthz is unauthenticated, cheap, and carries the build id", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      service: "crm-demo",
      build: "test-crmdemo-03",
    });
  });

  it("/healthz never carries tenant data", async () => {
    const body = await (await get("/healthz")).text();
    for (const tenant of plan.tenants) {
      expect(body).not.toContain(tenant.name);
      expect(body).not.toContain(tenant.slug);
    }
  });

  it("serves its stylesheet and forbids inline script by policy", async () => {
    const res = await get("/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("the login page exists, carries the synthetic-data banner, and offers no sign-up", async () => {
    const res = await get("/login");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Demo environment");
    expect(html.toLowerCase()).not.toContain("sign up");
    expect(html.toLowerCase()).not.toContain("create an account");
  });

  it("keeps the credentials off the login form itself — they live on /demo", async () => {
    const html = await (await get("/login")).text();
    for (const user of wumpus.users) {
      expect(html).not.toContain(user.email);
      expect(html).not.toContain(user.password);
    }
  });
});

// ------------------------------------------------------------ anonymous

describe("anonymous", () => {
  it.each(APP_ROUTES)("is redirected to the login page from %s", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith("/login")).toBe(true);
  });

  it("carries no tenant data in any redirect it receives", async () => {
    for (const path of APP_ROUTES) {
      const body = await (await get(path)).text();
      for (const org of wumpus.orgs) expect(body).not.toContain(esc(org.name));
    }
  });

  it("cannot reach a detail page by guessing a real id", async () => {
    const orgId = orgIdByName.get(wumpus.orgs[0]!.name)!;
    const res = await get(`/organizations/${orgId}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith("/login")).toBe(true);
  });

  it("is sent to the login page for unknown paths too", async () => {
    const res = await get("/not-a-route");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("is refused with a bad password, and told nothing about the account", async () => {
    const user = userOf(wumpus, "ada");
    const res = await postForm("/login", { email: user.email, password: "not-the-password" });
    const html = await res.text();
    expect(res.status).toBe(401);
    expect(html).toContain("did not work");
    expect(res.headers.getSetCookie().filter((c) => c.includes("crm-access="))).toHaveLength(0);
  });

  it("gets the same refusal for an account that does not exist", async () => {
    const res = await postForm("/login", {
      email: "nobody@wumpus-widgets.example",
      password: "demo-wumpus-widgets-nobody",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("did not work");
  });
});

// ------------------------------------------------------------ deactivation

describe("a deactivated member", () => {
  const deactivated = [
    { tenant: wumpus, key: "dana" },
    { tenant: wumpus, key: "casey" },
    { tenant: bandersnatch, key: "theo" },
    { tenant: moonrise, key: "lou" },
  ];

  it.each(deactivated)(
    "authenticates but is refused a session ($tenant.slug/$key)",
    async ({ tenant, key }) => {
      const user = userOf(tenant, key);
      const res = await postForm("/login", { email: user.email, password: user.password });
      const html = await res.text();
      expect(res.status).toBe(401);
      expect(html).toContain("deactivated");
      expect(html).not.toContain(esc(tenant.orgs[0]!.name));
      expect(res.headers.getSetCookie().filter((c) => /crm-access=[^;]/.test(c))).toHaveLength(0);
    },
  );
});

// ------------------------------------------------------------ role × route

describe("role × route", () => {
  const principals = plan.tenants.flatMap((tenant) =>
    tenant.users.filter((u) => u.active).map((user) => ({ tenant, user })),
  );

  for (const { tenant, user } of principals) {
    for (const path of APP_ROUTES) {
      it(`${tenant.slug}/${user.key} (${user.role}) reads ${path}`, async () => {
        const res = await get(path, cookieOf(tenant, user.key));
        const html = await res.text();
        expect(res.status).toBe(200);
        // chrome contract: own tenant named, own role shown, banner present
        expect(html).toContain(tenant.name);
        expect(html).toContain(user.displayName);
        expect(html).toContain("Demo environment");
        // and nobody else's world, anywhere in the bytes
        for (const other of plan.tenants.filter((t) => t.slug !== tenant.slug)) {
          for (const org of other.orgs) expect(html).not.toContain(esc(org.name));
        }
      });
    }
  }

  it("the banner one-liner states the posture the app is actually in", () => {
    // It was a written-down constant until 05, and it claimed a schedule
    // this build does not yet run. It now derives from RESET_POSTURE, so
    // the banner and the public credentials page cannot tell a visitor two
    // different stories (src/views/demo.ts).
    expect(BANNER_TEXT).toBe(
      RESET_POSTURE.scheduled
        ? "Demo environment — synthetic data, resets on schedule."
        : "Demo environment — synthetic data, reset by hand until the scheduled reset ships.",
    );
  });

  it("no page renders a style attribute its own CSP would throw away", async () => {
    // the real-browser regression (04): style-src 'self' blocks style
    // ATTRIBUTES too, so an inline one is dead markup plus a console error
    for (const path of APP_ROUTES) {
      const html = await (await get(path, cookieOf(wumpus, "ada"))).text();
      expect(html, `${path} renders an inline style`).not.toContain('style="');
    }
  });
});

// ------------------------------------------------------------ what a tenant sees

describe("each tenant sees exactly its own world", () => {
  for (const tenant of plan.tenants) {
    const admin = tenant.users.find((u) => u.role === "admin" && u.active)!;

    it(`${tenant.slug}: the organizations list is its ${tenant.expected.organizations} orgs`, async () => {
      const html = await (
        await get("/organizations", cookieOf(tenant, admin.key))
      ).text();
      expect(countMatches(html, new RegExp(`href="/organizations/${UUID}"`, "g"))).toBe(
        tenant.expected.organizations,
      );
      for (const org of tenant.orgs) expect(html).toContain(esc(org.name));
    });

    it(`${tenant.slug}: the people list is its ${tenant.expected.people} people`, async () => {
      const html = await (await get("/people", cookieOf(tenant, admin.key))).text();
      expect(countMatches(html, new RegExp(`href="/people/${UUID}"`, "g"))).toBe(
        tenant.expected.people,
      );
    });

    it(`${tenant.slug}: the deals list is its ${tenant.expected.deals} deals`, async () => {
      const html = await (await get("/deals", cookieOf(tenant, admin.key))).text();
      expect(countMatches(html, new RegExp(`href="/deals/${UUID}"`, "g"))).toBe(
        tenant.expected.deals,
      );
    });

    it(`${tenant.slug}: the board renders every stage and every deal as a card`, async () => {
      const html = await (await get("/deals/board", cookieOf(tenant, admin.key))).text();
      expect(countMatches(html, /class="card"/g)).toBe(tenant.expected.deals);
      // all six columns, always — including the empty ones
      for (const label of ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]) {
        expect(html).toContain(`<h2>${label}</h2>`);
      }
      for (const [stage, count] of Object.entries(tenant.expected.dealsByStage)) {
        if (count === 0) continue;
        expect(html, `${tenant.slug} has ${count} deals at ${stage}`).toContain(
          `class="column ${stage}"`,
        );
      }
    });

    it(`${tenant.slug}: the activity feed is its ${tenant.expected.activities} activities`, async () => {
      const html = await (await get("/activities", cookieOf(tenant, admin.key))).text();
      expect(countMatches(html, /class="subject"/g)).toBe(tenant.expected.activities);
    });
  }

  it("a rep sees the whole tenant's deals, not only their own book", async () => {
    const html = await (await get("/deals", cookieOf(wumpus, "riley"))).text();
    expect(countMatches(html, new RegExp(`href="/deals/${UUID}"`, "g"))).toBe(
      wumpus.expected.deals,
    );
  });
});

// ------------------------------------------------------------ cross-tenant, at the page

describe("cross-tenant reads return nothing, at the rendered page", () => {
  it("a Wumpus admin asking for a Bandersnatch organization gets 'not found'", async () => {
    const foreign = orgIdByName.get(bandersnatch.orgs[0]!.name)!;
    const res = await get(`/organizations/${foreign}`, cookieOf(wumpus, "ada"));
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).not.toContain(esc(bandersnatch.orgs[0]!.name));
  });

  it("…and for a Bandersnatch deal", async () => {
    const foreign = dealIdByName.get(bandersnatch.deals[0]!.name)!;
    const res = await get(`/deals/${foreign}`, cookieOf(wumpus, "ada"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(esc(bandersnatch.deals[0]!.name));
  });

  it("…and for a Bandersnatch person", async () => {
    const { data } = await service
      .from("people")
      .select("id, tenant_id, tenants(slug)")
      .limit(200);
    const rows = (data ?? []) as { id: string; tenants: { slug: string } | { slug: string }[] }[];
    const foreign = rows.find((r) => {
      const t = Array.isArray(r.tenants) ? r.tenants[0] : r.tenants;
      return t?.slug === bandersnatch.slug;
    });
    expect(foreign, "no bandersnatch person seeded").toBeTruthy();
    const res = await get(`/people/${foreign!.id}`, cookieOf(wumpus, "ada"));
    expect(res.status).toBe(404);
  });

  it("a search cannot be steered across the boundary", async () => {
    const term = encodeURIComponent(bandersnatch.orgs[0]!.name.split(" ")[0]!);
    const html = await (
      await get(`/organizations?q=${term}`, cookieOf(wumpus, "ada"))
    ).text();
    expect(html).not.toContain(esc(bandersnatch.orgs[0]!.name));
  });

  it("a foreign owner filter yields the reader's own tenant only, never an error", async () => {
    const { data } = await service
      .from("memberships")
      .select("user_id, tenants(slug)")
      .limit(200);
    const rows = (data ?? []) as {
      user_id: string;
      tenants: { slug: string } | { slug: string }[];
    }[];
    const foreign = rows.find((r) => {
      const t = Array.isArray(r.tenants) ? r.tenants[0] : r.tenants;
      return t?.slug === bandersnatch.slug;
    });
    const res = await get(`/deals?owner=${foreign!.user_id}`, cookieOf(wumpus, "ada"));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(countMatches(html, new RegExp(`href="/deals/${UUID}"`, "g"))).toBe(0);
    for (const org of bandersnatch.orgs) expect(html).not.toContain(esc(org.name));
  });
});

// ------------------------------------------------------------ detail surfaces

describe("detail surfaces", () => {
  it("an organization page shows its people, its deals and its trail", async () => {
    const org = wumpus.orgs[0]!;
    const orgIndex = 0;
    const html = await (
      await get(`/organizations/${orgIdByName.get(org.name)!}`, cookieOf(wumpus, "ada"))
    ).text();
    expect(html).toContain(esc(org.name));
    expect(html).toContain(org.city);
    // count the TABLE cells: the activity trail below also links people and
    // deals, and conflating the two would make this assertion drift.
    const expectedPeople = wumpus.people.filter((p) => p.orgIndex === orgIndex).length;
    expect(countMatches(html, new RegExp(`<td><a href="/people/${UUID}"`, "g"))).toBe(
      expectedPeople,
    );
    const expectedDeals = wumpus.deals.filter((d) => d.orgIndex === orgIndex).length;
    expect(countMatches(html, new RegExp(`<td><a href="/deals/${UUID}"`, "g"))).toBe(
      expectedDeals,
    );
  });

  it("a person page links their organization and shows their trail", async () => {
    const { data } = await service
      .from("people")
      .select("id, first_name, last_name, org_id, tenant_id")
      .limit(500);
    const person = (data ?? []).find(
      (p: { first_name: string }) =>
        wumpus.people.some((sp) => sp.firstName === p.first_name),
    ) as { id: string; first_name: string; last_name: string; org_id: string };
    const html = await (await get(`/people/${person.id}`, cookieOf(wumpus, "ada"))).text();
    expect(html).toContain(`${person.first_name} ${person.last_name}`);
    expect(html).toContain(`href="/organizations/${person.org_id}"`);
  });

  it("a deal page shows the audited stage history to an admin", async () => {
    const reopened = wumpus.deals.find((d) => d.reopened)!;
    const id = dealIdByName.get(reopened.name)!;
    const html = await (await get(`/deals/${id}`, cookieOf(wumpus, "ada"))).text();
    expect(html).toContain("Deal history");
    expect(html).toContain("Reopened");
    expect(html).toContain("Negotiation → Won");
  });

  it("…and tells a rep plainly that the audit trail is not theirs to see", async () => {
    const reopened = wumpus.deals.find((d) => d.reopened)!;
    const id = dealIdByName.get(reopened.name)!;
    const html = await (await get(`/deals/${id}`, cookieOf(wumpus, "riley"))).text();
    expect(html).toContain("Deal history");
    expect(html).toContain("tenant admins only");
    expect(html).not.toContain("Negotiation → Won");
  });

  it("a malformed id is a plain not-found, not a database error", async () => {
    const res = await get("/deals/not-a-uuid", cookieOf(wumpus, "ada"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Not found");
  });
});

// ------------------------------------------------------------ the 05 surfaces
//
// /reports and /admin/users are offered by role. The refusal on /reports is
// WAYFINDING and the page says so — every member may read the deals it adds
// up. The refusal on /admin/users is wayfinding too, but the act behind it
// is genuinely closed: the RPCs check the caller's role themselves, which
// test/writes.test.ts proves by crafting the request anyway.

describe("role × the manager and admin surfaces", () => {
  for (const tenant of plan.tenants) {
    const expectations = [
      { key: tenant.users.find((u) => u.role === "admin" && u.active)!.key, reports: 200, admin: 200 },
      { key: tenant.users.find((u) => u.role === "manager" && u.active)!.key, reports: 200, admin: 403 },
      { key: tenant.users.find((u) => u.role === "rep" && u.active)!.key, reports: 403, admin: 403 },
    ];

    for (const { key, reports, admin } of expectations) {
      it(`${tenant.slug}/${key} gets ${reports} from /reports and ${admin} from /admin/users`, async () => {
        const cookie = cookieOf(tenant, key);
        const onReports = await get("/reports", cookie);
        expect(onReports.status).toBe(reports);
        const onAdmin = await get("/admin/users", cookie);
        expect(onAdmin.status).toBe(admin);

        // whatever the answer, it is this tenant's page and nobody else's world
        for (const html of [await onReports.text(), await onAdmin.text()]) {
          for (const other of plan.tenants.filter((t) => t.slug !== tenant.slug)) {
            for (const org of other.orgs) expect(html).not.toContain(esc(org.name));
            for (const user of other.users) expect(html).not.toContain(user.displayName);
          }
        }
      });
    }
  }

  it("offers the reports link to a manager and not to a rep", async () => {
    const managerNav = await (await get("/", cookieOf(wumpus, "morgan"))).text();
    expect(managerNav).toContain('href="/reports"');
    expect(managerNav).not.toContain('href="/admin/users"');

    const repNav = await (await get("/", cookieOf(wumpus, "riley"))).text();
    expect(repNav).not.toContain('href="/reports"');
    expect(repNav).not.toContain('href="/admin/users"');

    const adminNav = await (await get("/", cookieOf(wumpus, "ada"))).text();
    expect(adminNav).toContain('href="/reports"');
    expect(adminNav).toContain('href="/admin/users"');
  });

  it("tells a rep what the limit on the rollups actually is, without overstating it", async () => {
    const html = await (await get("/reports", cookieOf(wumpus, "riley"))).text();
    expect(html).toContain("manager surface");
    // the honest part: it does not claim the database is keeping this secret
    expect(html).toContain("one at a time");
  });

  it("renders no inline style on either surface", async () => {
    for (const path of ["/reports", "/admin/users"]) {
      const html = await (await get(path, cookieOf(wumpus, "ada"))).text();
      expect(html, `${path} renders an inline style`).not.toContain('style="');
    }
  });

  it("the admin roster shows every account, active and deactivated, and no controls for self", async () => {
    const html = await (await get("/admin/users", cookieOf(wumpus, "ada"))).text();
    for (const user of wumpus.users) expect(html).toContain(user.displayName);
    expect(html).toContain("Deactivated");
    // no user creation in v1, and the page says so rather than hiding it
    expect(html).toContain("does not create accounts");
    // the signed-in admin's own row carries no role select
    const ada = wumpus.users.find((u) => u.key === "ada")!;
    const ownRow = html.slice(html.indexOf(ada.displayName));
    expect(ownRow.slice(0, ownRow.indexOf("</tr>"))).not.toContain("<select");
  });

  it("a role select opens on a placeholder, never on a role", async () => {
    // found by looking at the rendered page: defaulting to the first role
    // in the vocabulary made every row's one-click action "promote to
    // tenant admin"
    const html = await (await get("/admin/users", cookieOf(wumpus, "ada"))).text();
    const selects = html.match(/<select[\s\S]*?<\/select>/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select).toContain('<option value="">');
      expect(select.indexOf('<option value="">')).toBeLessThan(select.indexOf('<option value="a'));
    }
  });
});

// ------------------------------------------------------------ reconciliation
//
// THE RECONCILIATION SPOT-CHECK. Every number a manager reads is traced
// back to the scenario plan — not to the report module that computed it,
// which would only prove the code agrees with itself. The chain is:
// scenario.ts (the seed's spec) → the seeded rows → the rendered page.

/** The count and value cells of one stage row on the rendered report. */
const stageCells = (html: string, stage: DealStage): { count: number; value: string } => {
  const re = new RegExp(
    `/deals\\?stage=${stage}"[\\s\\S]*?<td class="right num">(\\d+)</td>\\s*<td class="right num">([^<]+)</td>`,
  );
  const found = html.match(re);
  expect(found, `no ${stage} row on the report`).toBeTruthy();
  return { count: Number(found![1]), value: found![2]! };
};

/** The four numeric cells of one owner's row. */
const ownerCells = (html: string, displayName: string): string[] => {
  const re = new RegExp(`>${displayName}</a></td>((?:<td class="right num">[^<]*</td>\\s*){4})`);
  const found = html.match(re);
  expect(found, `no row for ${displayName} on the report`).toBeTruthy();
  return [...found![1]!.matchAll(/<td class="right num">([^<]*)<\/td>/g)].map((m) => m[1]!);
};

describe("every rendered number reconciles to the seed, exactly", () => {
  it("the pipeline table's stage counts and values are the plan's deals, stage by stage", async () => {
    const html = await (await get("/reports", cookieOf(wumpus, "morgan"))).text();
    for (const stage of ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const) {
      const seeded = wumpus.deals.filter((d) => d.targetStage === stage);
      const cells = stageCells(html, stage);
      expect(cells.count, `${stage} count`).toBe(seeded.length);
      expect(cells.count, `${stage} count vs the plan's own expectation`).toBe(
        wumpus.expected.dealsByStage[stage],
      );
      expect(cells.value, `${stage} value`).toBe(
        money(seeded.reduce((total, d) => total + d.amount, 0)),
      );
    }
  });

  it("the owner cut is the same deals again, per owner", async () => {
    const html = await (await get("/reports", cookieOf(wumpus, "morgan"))).text();
    const ownerKeys = [...new Set(wumpus.deals.map((d) => d.ownerKey))];
    for (const key of ownerKeys) {
      const user = wumpus.users.find((u) => u.key === key)!;
      const theirs = wumpus.deals.filter((d) => d.ownerKey === key);
      const open = theirs.filter((d) =>
        (OPEN_STAGES as readonly DealStage[]).includes(d.targetStage),
      );
      const cells = ownerCells(html, user.displayName);
      expect(cells[0], `${key} open count`).toBe(String(open.length));
      expect(cells[1], `${key} open value`).toBe(
        money(open.reduce((total, d) => total + d.amount, 0)),
      );
      expect(cells[2], `${key} deal count`).toBe(String(theirs.length));
      expect(cells[3], `${key} value`).toBe(
        money(theirs.reduce((total, d) => total + d.amount, 0)),
      );
    }
  });

  it("the activity volume totals the plan's activities, by kind and altogether", async () => {
    const html = await (await get("/reports", cookieOf(wumpus, "morgan"))).text();
    const footer = html.match(
      /<th>(\d+) weeks<\/th>\s*((?:<td class="right num">\d+<\/td>\s*){5})/,
    );
    expect(footer, "no total row on the activity table").toBeTruthy();
    const weeks = Number(footer![1]);
    const cells = [...footer![2]!.matchAll(/<td class="right num">(\d+)<\/td>/g)].map((m) =>
      Number(m[1]),
    );

    // the whole seeded trail falls inside the window, so the page's total
    // is the plan's count — if the seed ever reaches further back than the
    // report's window, this is the assertion that says so
    const oldest = Math.max(...wumpus.activities.map((a) => a.daysAgo));
    expect(oldest, "the seed now reaches past the report window").toBeLessThan(weeks * 7);

    ACTIVITY_TYPES.forEach((type, i) => {
      expect(cells[i], `${type} total`).toBe(
        wumpus.activities.filter((a) => a.type === type).length,
      );
    });
    expect(cells[4], "activity total").toBe(wumpus.activities.length);
    expect(cells[4]).toBe(wumpus.expected.activities);
  });

  it("the win rate is the plan's won and lost, divided", async () => {
    const html = await (await get("/reports", cookieOf(wumpus, "morgan"))).text();
    const won = wumpus.expected.dealsByStage.won;
    const lost = wumpus.expected.dealsByStage.lost;

    const rate = html.match(/<span class="n num">(\d+)%<\/span><span class="eyebrow">Win rate/);
    expect(rate, "no win rate on the report").toBeTruthy();
    expect(Number(rate![1])).toBe(Math.round((won / (won + lost)) * 100));

    for (const [label, count] of [
      ["Won", won],
      ["Lost", lost],
    ] as const) {
      const tile = html.match(
        new RegExp(`<span class="n num">(\\d+)</span><span class="eyebrow">${label}</span>`),
      );
      expect(tile, `no ${label} tile`).toBeTruthy();
      expect(Number(tile![1]), label).toBe(count);
    }
  });

  it("a tenant that has closed nothing gets no win rate rather than a 0%", async () => {
    // moonrise seeds no won and no lost deals — the empty-data case a demo
    // is most likely to render as a made-up zero
    expect(moonrise.expected.dealsByStage.won + moonrise.expected.dealsByStage.lost).toBe(0);
    const html = await (await get("/reports", cookieOf(moonrise, "marco"))).text();
    expect(html).toContain("Nothing has closed");
    expect(html).not.toContain('class="eyebrow">Win rate');
  });

  it("the pipeline totals agree with the deal list the same reader can count by hand", async () => {
    const html = await (await get("/reports", cookieOf(wumpus, "morgan"))).text();
    const all = wumpus.deals.reduce((total, d) => total + d.amount, 0);
    const open = wumpus.deals.filter((d) =>
      (OPEN_STAGES as readonly DealStage[]).includes(d.targetStage),
    );
    expect(html).toContain(
      `<span class="n num">${open.length}</span><span class="eyebrow">Open deals</span>`,
    );
    expect(html).toContain(
      `<span class="n num">${money(open.reduce((t, d) => t + d.amount, 0))}</span><span class="eyebrow">Open pipeline</span>`,
    );
    expect(html).toContain(
      `<span class="n num">${money(all)}</span><span class="eyebrow">Value all-time</span>`,
    );
  });
});

// ------------------------------------------------------------ the front door

describe("the demo logins page", () => {
  it("is public, and needs no session at all", async () => {
    const res = await get("/demo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("publishes every seeded account of every tenant, as seeded", async () => {
    const html = await (await get("/demo")).text();
    for (const tenant of demoTenants()) {
      expect(html).toContain(esc(tenant.name));
      for (const login of tenant.logins) {
        expect(html, `${login.email} is not published`).toContain(login.email);
        expect(html, `${login.email}'s password is not published`).toContain(login.password);
        expect(html).toContain(login.displayName);
      }
    }
  });

  it("EVERY published credential actually works — a stale page is a failed demo", async () => {
    for (const tenant of demoTenants()) {
      for (const login of tenant.logins) {
        const res = await postForm("/login", { email: login.email, password: login.password });
        if (login.active) {
          expect(res.status, `${login.email} is published but cannot sign in`).toBe(303);
        } else {
          // published on purpose: the refusal is a demo beat
          expect(res.status, `${login.email} is published as deactivated`).toBe(401);
          expect(await res.text()).toContain("deactivated");
        }
      }
    }
  });

  it("publishes nothing beyond the credentials — no tenant's rows are on it", async () => {
    const html = await (await get("/demo")).text();
    for (const tenant of plan.tenants) {
      for (const org of tenant.orgs) expect(html).not.toContain(esc(org.name));
      for (const deal of tenant.deals) expect(html).not.toContain(esc(deal.name));
      for (const person of tenant.people) {
        expect(html).not.toContain(`${person.firstName} ${person.lastName}`);
      }
    }
  });

  it("states the posture plainly, and the reset posture it is actually in", async () => {
    const html = await (await get("/demo")).text();
    expect(html).toContain(esc(resetCopy()));
    if (!RESET_POSTURE.scheduled) expect(html).toContain("not running yet");
    expect(html).toContain("no SLA");
    expect(html).toContain("Demo environment");
    expect(html.toLowerCase()).toContain("self-signup is disabled");
    expect(html).toContain(".example");
  });

  it("invites the isolation beat by name", async () => {
    const html = await (await get("/demo")).text();
    expect(html).toContain(esc(wumpus.name));
    expect(html).toContain(esc(bandersnatch.name));
    expect(html).toContain("not found");
  });

  it("renders no inline style", async () => {
    expect(await (await get("/demo")).text()).not.toContain('style="');
  });

  it("is where the login page sends a visitor, and the login page still publishes nothing", async () => {
    const html = await (await get("/login")).text();
    expect(html).toContain('href="/demo"');
    for (const tenant of plan.tenants) {
      for (const user of tenant.users) {
        expect(html).not.toContain(user.email);
        expect(html).not.toContain(user.password);
      }
    }
  });

  it("is linked from the standing banner, on every page", async () => {
    for (const path of ["/login", "/demo", "/"]) {
      const cookie = path === "/" ? cookieOf(wumpus, "ada") : undefined;
      expect(await (await get(path, cookie)).text()).toContain('<a href="/demo">');
    }
  });
});

// ------------------------------------------------------------ session lifecycle

describe("session lifecycle", () => {
  it("signing out clears the session cookies and the next read redirects", async () => {
    const cookie = await signIn(userOf(moonrise, "ana"));
    const out = await app.request(
      "/logout",
      { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" } },
      env,
    );
    expect(out.status).toBe(303);
    const cleared = out.headers.getSetCookie().join("; ");
    expect(cleared).toContain("crm-access=");
    expect(cleared).toContain("Max-Age=0");
  });

  it("a garbage session cookie is not a session", async () => {
    const res = await get("/organizations", "crm-access=not-a-jwt");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith("/login")).toBe(true);
  });

  it("a signed-in reader visiting /login is sent to their overview", async () => {
    const res = await get("/login", cookieOf(wumpus, "ada"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("the post-login destination cannot be pointed off-site", async () => {
    const user = userOf(moonrise, "marco");
    const res = await postForm("/login", {
      email: user.email,
      password: user.password,
      next: "//evil.example/",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("honours a local post-login destination", async () => {
    const user = userOf(moonrise, "remy");
    const res = await postForm("/login", {
      email: user.email,
      password: user.password,
      next: "/deals/board",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/deals/board");
  });
});

// ------------------------------------------------------------ request hygiene

describe("request hygiene", () => {
  it("refuses an oversized body without reading it", async () => {
    const res = await app.request(
      "/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "500000",
        },
        body: "email=a&password=b",
      },
      env,
    );
    expect(res.status).toBe(413);
  });

  it("accepts a same-origin form post the way a browser sends it", async () => {
    // The real-browser regression: a Chromium form submit carries an
    // explicit Origin, and it must be honoured. (`Origin: null` — what
    // `Referrer-Policy: no-referrer` would produce — is refused.)
    const user = userOf(moonrise, "ana");
    const res = await postForm(
      "/login",
      { email: user.email, password: user.password },
      { origin: "http://localhost" },
    );
    expect(res.status).toBe(303);

    const nulled = await postForm(
      "/login",
      { email: user.email, password: user.password },
      { origin: "null" },
    );
    expect(nulled.status).toBe(403);
  });

  it("refuses a cross-origin form post", async () => {
    const user = userOf(wumpus, "ada");
    const res = await postForm(
      "/login",
      { email: user.email, password: user.password },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  it("marks authenticated pages no-store", async () => {
    const res = await get("/deals", cookieOf(wumpus, "ada"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
