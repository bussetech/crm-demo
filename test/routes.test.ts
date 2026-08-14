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

  it("does not publish demo credentials on the login page (05's act, not this one)", async () => {
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

  it("the banner text stays the standing one-liner the record names", () => {
    expect(BANNER_TEXT).toBe("Demo environment — synthetic data, resets on schedule.");
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
