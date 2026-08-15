// crm-demo — Workers entry point (Hono + SSR JSX, the stratum shape).
//
// CRMDEMO-EPIC1-03 made the seeded world VISIBLE; -04 makes it WRITABLE:
// a rep adds an organization, a contact, logs a call, advances a deal and
// closes it won, and every step of that lands in an audit trail the
// database wrote.
//
// Two properties hold across every handler below, and the tests pin both:
//
//  * THE AUTHORIZATION BOUNDARY IS THE DATABASE. Guards here are
//    wayfinding — they decide where a request goes and what a page
//    OFFERS, never what a query may see or a write may do. A guard that
//    got it wrong would leak nothing and change nothing, because the
//    query still runs as the user.
//  * NO BUSINESS RULE IS WRITTEN IN THIS FILE. Stage legality comes from
//    src/domain/stages.ts, role capability from src/domain/roles.ts,
//    input shape from src/domain/validation.ts. test/source.test.ts greps
//    this file to keep that true — no stage names, no role names, no
//    thresholds inlined here.
//
// The write paths run on the signed-in user's client like every read, via
// src/views/writes.ts. There is still no service-role client in a request
// path and no binding one could be built from.
import { Hono } from "hono";
import type { HtmlEscapedString } from "hono/utils/html";

import {
  clearSessionCookies,
  isResponse,
  requireSession,
  sameOrigin,
  sessionMiddleware,
  setSessionCookies,
  loadProfile,
  type AppContext,
  type AuthVars,
} from "./auth";
import { anonClient, userClient } from "./db";
import type { CrmProfile, Env } from "./env";
import { ACTIVITY_TYPES, isActivityType } from "./domain/activity";
import {
  canCreateDeal,
  canCreateRecords,
  canManageMemberships,
  canReadAuditLog,
  canReadReports,
  canReopenDeal,
  canUpdateDeal,
  isMemberRole,
  type Membership,
} from "./domain/roles";
import {
  DEAL_STAGES,
  allowedTransitions,
  isTerminalStage,
  type DealStage,
} from "./domain/stages";
import { APP_CSS } from "./ui/styles";
import { PublicShell, Shell } from "./ui/layout";
import {
  ActivityFormPage,
  AuditPage,
  DealFormPage,
  OrgFormPage,
  PersonFormPage,
  type ActivityValues,
  type DealValues,
  type OrgValues,
  type PersonValues,
} from "./ui/forms";
import {
  ActivityPage,
  BoardPage,
  DealDetailPage,
  DealListPage,
  ErrorPage,
  LoginPage,
  NotFoundPage,
  OrgDetailPage,
  OrgListPage,
  OverviewPage,
  PeopleListPage,
  PersonDetailPage,
  RefusedPage,
  WriteRefusedPage,
} from "./ui/pages";
import {
  ReadFailed,
  boardOf,
  loadActivities,
  loadActivityPulse,
  loadAuditFeed,
  loadDeal,
  loadDealHistory,
  loadDeals,
  loadDealsForReport,
  loadOrg,
  loadOrgs,
  loadPeople,
  loadPerson,
  loadRoster,
  rosterIndex,
  type Activity,
  type Deal,
  type Member,
} from "./views/model";
import { WEEK_MS, activityByWeek } from "./views/reports";
import { AdminUsersPage } from "./ui/admin";
import { DemoLoginsPage } from "./ui/demo";
import { ReportsPage } from "./ui/reports";
import {
  createDeal,
  createOrganization,
  createPerson,
  logActivity,
  reopenDeal,
  setDealStage,
  setMembershipActive,
  setMembershipRole,
  updateDeal,
  updateOrganization,
  updatePerson,
} from "./views/writes";

export type { Env };

export const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVars> }>();

// ------------------------------------------------------------ page helpers

/** What a component renders — hono/jsx does not export a JSX.Element alias. */
type Node = HtmlEscapedString | Promise<HtmlEscapedString>;

type PageStatus = 200 | 400 | 401 | 403 | 404 | 500;

/** SSR a document. Components are synchronous; the await is the safe form. */
async function page(
  c: AppContext,
  node: Node,
  status: PageStatus = 200,
): Promise<Response> {
  const body = await node;
  return c.html(`<!doctype html>${body}`, status);
}

const shell = (c: AppContext, profile: CrmProfile, title: string, node: Node) => (
  <Shell
    title={title}
    profile={profile}
    path={new URL(c.req.url).pathname}
    buildId={c.env.APP_BUILD_ID ?? "dev"}
  >
    {node}
  </Shell>
);

const publicPage = (c: AppContext, title: string, node: Node) => (
  <PublicShell title={title} buildId={c.env.APP_BUILD_ID ?? "dev"}>
    {node}
  </PublicShell>
);

const notFound = (c: AppContext, profile: CrmProfile) =>
  page(c, shell(c, profile, "Not found", <NotFoundPage />), 404);

/**
 * A write that affected no rows. Three different truths produce it — the
 * record is gone, it belongs to another tenant, or it belongs to another
 * member's book — and this app deliberately does not say which, for the
 * same reason a foreign id reads as 404 rather than 403. 404 is the
 * status because from this reader's side there is nothing there to change.
 */
const writeRefused = (c: AppContext, profile: CrmProfile) =>
  page(c, shell(c, profile, "Nothing changed", <WriteRefusedPage />), 404);

/**
 * Wayfinding for a form this reader's role may not use. Unlike the above
 * this is NOT an oracle: they can already see the record — the page is
 * only declining to render a control the database would refuse anyway.
 */
const refused = (c: AppContext, profile: CrmProfile, detail: string) =>
  page(c, shell(c, profile, "Not yours to change", <RefusedPage detail={detail} />), 403);

/** The capability question every affordance below asks the domain module. */
const membershipOf = (profile: CrmProfile): Membership => ({
  role: profile.membership.role,
  // a session only exists for an ACTIVE membership: loadProfile filters on
  // it, read through the user's own JWT (src/auth.ts)
  active: true,
});

// ------------------------------------------------------------ form fields

const field = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();

const nullable = (value: string): string | null => (value === "" ? null : value);

/**
 * A reference that arrived in a form. Shape only — whether the id names
 * something this tenant owns is the composite foreign key's answer, and
 * whether this reader may link it is RLS's. Both refuse loudly.
 */
const reference = (form: FormData, name: string): string | null => {
  const raw = field(form, name);
  return isUuid(raw) ? raw : null;
};

/** The confirmation the post-write redirect carries (src/ui/layout.tsx). */
const flashOf = (c: AppContext): string | undefined => c.req.query("saved") ?? undefined;

/** The legal moves a reader may make on a deal — offered, never enforced. */
const movesFor = (profile: CrmProfile, deal: Deal): DealStage[] =>
  canUpdateDeal(membershipOf(profile), deal.ownerId === profile.userId)
    ? allowedTransitions(deal.stage)
    : [];

// ------------------------------------------------------------ middleware

/**
 * A fixed, tight policy: this app ships no client-side JavaScript at all,
 * so scripts are forbidden outright rather than allow-listed. The
 * stylesheet is a real route (/app.css) precisely so `style-src` can stay
 * 'self' instead of granting 'unsafe-inline'.
 */
const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; " +
  "base-uri 'none'; frame-ancestors 'none'";

app.use("*", async (c, next) => {
  await next();
  c.header("content-security-policy", CSP);
  c.header("x-content-type-options", "nosniff");
  // `same-origin`, NOT `no-referrer`: under no-referrer a browser sends
  // `Origin: null` on form posts, which turns the CSRF check in
  // src/auth.ts into a refusal of every real sign-in. Same-origin still
  // sends nothing to other sites.
  c.header("referrer-policy", "same-origin");
  c.header("x-frame-options", "DENY");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  const path = new URL(c.req.url).pathname;
  if (path !== "/app.css") c.header("cache-control", "no-store");
});

/**
 * A body cap (track law 3). The only bodies this app accepts are the login
 * and logout forms; nothing here uploads, and nothing here should be
 * willing to read a megabyte to find that out.
 */
const MAX_BODY_BYTES = 4096;

app.use("*", async (c, next) => {
  if (c.req.method === "POST") {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.text("Request body too large", 413);
    }
    if (!sameOrigin(c)) return c.text("Cross-origin form posts are refused", 403);
  }
  return next();
});

// ------------------------------------------------------------ public routes

// Registered BEFORE the session middleware, deliberately: ADR-0023 §4 wants
// /healthz unauthenticated, cheap and side-effect-free, and a probe should
// never cost a token verification. The stylesheet is static for the same
// reason.
app.get("/healthz", (c) =>
  c.json({ ok: true, service: "crm-demo", build: c.env.APP_BUILD_ID ?? "dev" }),
);

app.get("/app.css", (c) =>
  c.body(APP_CSS, 200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=3600",
  }),
);

/**
 * The demo logins page — public, and registered here with the other
 * unauthenticated routes because it is the FRONT DOOR: a visitor who has
 * not signed in yet is exactly its audience, and reading it should never
 * cost a token verification.
 *
 * The credentials it publishes are derived from the seed plan rather than
 * written down (src/views/demo.ts), so a login that works is a login this
 * page lists, and vice versa. The route proof signs in with every one of
 * them to keep that from being a claim.
 */
app.get("/demo", (c) => page(c, publicPage(c, "Demo logins", <DemoLoginsPage />)));

// Everything below resolves the session first (an absent one attaches
// nothing and falls through).
app.use("*", sessionMiddleware);

/** Only a local path may be a post-login destination — never an open redirect. */
const safeNext = (raw: string | undefined): string | undefined => {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
};

app.get("/login", (c) => {
  if (c.get("profile")) return c.redirect("/", 302);
  const next = safeNext(c.req.query("next"));
  return page(c, publicPage(c, "Sign in", <LoginPage next={next} />));
});

app.post("/login", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "") || undefined);

  const refuse = (message: string) =>
    page(c, publicPage(c, "Sign in", <LoginPage error={message} next={next} email={email} />), 401);

  if (!email || !password) return refuse("Enter an email address and a password.");

  const auth = anonClient(c.env);
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    // One message for both "no such account" and "wrong password": a login
    // form is not an account-enumeration oracle, demo or not.
    return refuse("That email and password combination did not work.");
  }

  const db = userClient(c.env, data.session.access_token);
  const profile = await loadProfile(db, data.user.id, data.user.email ?? null);
  if (!profile) {
    // The account authenticated; the membership is gone or deactivated. The
    // database made that call — this app just reports it.
    await auth.auth.signOut();
    clearSessionCookies(c);
    return refuse(
      "This account is deactivated. Its sign-in still works, but it has no access to any tenant's data.",
    );
  }

  setSessionCookies(c, data.session.access_token, data.session.refresh_token);
  return c.redirect(next ?? "/", 303);
});

app.post("/logout", (c) => {
  clearSessionCookies(c);
  return c.redirect("/login", 303);
});

// ------------------------------------------------------------ read surfaces

const now = () => new Date();

app.get("/", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const [roster, orgs, people, deals, activities] = await Promise.all([
    loadRoster(db),
    loadOrgs(db),
    loadPeople(db),
    loadDeals(db),
    loadActivities(db, { limit: 8 }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      profile.tenant.name,
      <OverviewPage
        tenantName={profile.tenant.name}
        orgCount={orgs.length}
        peopleCount={people.length}
        deals={deals}
        activities={activities}
        roster={rosterIndex(roster)}
        now={now()}
      />,
    ),
  );
});

app.get("/organizations", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const q = c.req.query("q") ?? "";
  const sortRaw = c.req.query("sort") ?? "name";
  const sort = sortRaw === "city" || sortRaw === "recent" ? sortRaw : "name";
  const orgs = await loadOrgs(db, { q, sort });

  return page(
    c,
    shell(
      c,
      profile,
      "Organizations",
      <OrgListPage
        orgs={orgs}
        q={q}
        sort={sort}
        canCreate={canCreateRecords(membershipOf(profile))}
      />,
    ),
  );
});

// --------------------------------------------- organizations: create / edit
//
// Registered BEFORE `/organizations/:id`: Hono matches in registration
// order, and a literal that arrives after its own wildcard is unreachable.

const EMPTY_ORG: OrgValues = { name: "", domain: "", industry: "", city: "" };

const orgForm = (
  c: AppContext,
  profile: CrmProfile,
  mode: "create" | "edit",
  action: string,
  cancelHref: string,
  values: OrgValues,
  error?: string,
) =>
  page(
    c,
    shell(
      c,
      profile,
      mode === "edit" ? "Edit organization" : "New organization",
      <OrgFormPage
        mode={mode}
        action={action}
        cancelHref={cancelHref}
        values={values}
        error={error}
      />,
    ),
    error ? 400 : 200,
  );

const orgValues = (form: FormData): OrgValues => ({
  name: field(form, "name"),
  domain: field(form, "domain"),
  industry: field(form, "industry"),
  city: field(form, "city"),
});

const orgInput = (values: OrgValues) => ({
  name: values.name,
  domain: nullable(values.domain),
  industry: nullable(values.industry),
  city: nullable(values.city),
});

app.get("/organizations/new", (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { profile } = session;
  if (!canCreateRecords(membershipOf(profile))) {
    return refused(c, profile, "Your role does not create records in this tenant.");
  }
  return orgForm(c, profile, "create", "/organizations", "/organizations", EMPTY_ORG);
});

app.post("/organizations", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const values = orgValues(await c.req.formData());
  const result = await createOrganization(db, profile, orgInput(values));
  if (result.ok) return c.redirect(`/organizations/${result.value}?saved=created`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return orgForm(c, profile, "create", "/organizations", "/organizations", values, result.reason);
});

app.get("/organizations/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  const org = await loadOrg(db, id);
  // A foreign tenant's organization is not "forbidden" here — it simply
  // does not exist for this reader, because RLS returned zero rows.
  if (!org) return notFound(c, profile);

  const [roster, people, deals, activities] = await Promise.all([
    loadRoster(db),
    loadPeople(db, { orgId: id }),
    loadDeals(db, { orgId: id }),
    loadActivities(db, { orgId: id, limit: 20 }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      org.name,
      <OrgDetailPage
        org={org}
        people={people}
        deals={deals}
        activities={activities}
        roster={rosterIndex(roster)}
        now={now()}
        canWrite={canCreateRecords(membershipOf(profile))}
        canCreateDeal={canCreateDeal(membershipOf(profile), true)}
        flash={flashOf(c)}
      />,
    ),
  );
});

app.get("/organizations/:id/edit", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  const org = await loadOrg(db, id);
  if (!org) return notFound(c, profile);

  return orgForm(
    c,
    profile,
    "edit",
    `/organizations/${id}`,
    `/organizations/${id}`,
    {
      name: org.name,
      domain: org.domain ?? "",
      industry: org.industry ?? "",
      city: org.city ?? "",
    },
  );
});

app.post("/organizations/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);

  const values = orgValues(await c.req.formData());
  const result = await updateOrganization(db, id, orgInput(values));
  if (result.ok) return c.redirect(`/organizations/${id}?saved=updated`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return orgForm(
    c,
    profile,
    "edit",
    `/organizations/${id}`,
    `/organizations/${id}`,
    values,
    result.reason,
  );
});

app.get("/people", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const q = c.req.query("q") ?? "";
  const people = await loadPeople(db, { q });

  return page(
    c,
    shell(
      c,
      profile,
      "People",
      <PeopleListPage
        people={people}
        q={q}
        canCreate={canCreateRecords(membershipOf(profile))}
      />,
    ),
  );
});

// ---------------------------------------------------- people: create / edit

const emptyPerson = (orgId: string): PersonValues => ({
  firstName: "",
  lastName: "",
  email: "",
  title: "",
  phone: "",
  orgId,
});

const personValues = (form: FormData): PersonValues => ({
  firstName: field(form, "firstName"),
  lastName: field(form, "lastName"),
  email: field(form, "email"),
  title: field(form, "title"),
  phone: field(form, "phone"),
  orgId: field(form, "orgId"),
});

const personForm = async (
  c: AppContext,
  db: AuthVars["db"],
  profile: CrmProfile,
  mode: "create" | "edit",
  action: string,
  cancelHref: string,
  values: PersonValues,
  error?: string,
) => {
  const orgs = await loadOrgs(db);
  return page(
    c,
    shell(
      c,
      profile,
      mode === "edit" ? "Edit contact" : "New contact",
      <PersonFormPage
        mode={mode}
        action={action}
        cancelHref={cancelHref}
        orgs={orgs}
        values={values}
        error={error}
      />,
    ),
    error ? 400 : 200,
  );
};

/**
 * The organization link is required and must be a well-formed id. That is
 * a SHAPE check, not a permission one: whether the organization is this
 * tenant's is settled by the composite foreign key (tenant_id, org_id),
 * which cannot reference another tenant's row at all.
 */
const REQUIRES_ORG = "Choose an organization for this contact.";

app.get("/people/new", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;
  if (!canCreateRecords(membershipOf(profile))) {
    return refused(c, profile, "Your role does not create records in this tenant.");
  }
  const preset = c.req.query("org") ?? "";
  return personForm(
    c,
    db,
    profile,
    "create",
    "/people",
    isUuid(preset) ? `/organizations/${preset}` : "/people",
    emptyPerson(isUuid(preset) ? preset : ""),
  );
});

app.post("/people", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const form = await c.req.formData();
  const values = personValues(form);
  const orgId = reference(form, "orgId");
  if (!orgId) {
    return personForm(c, db, profile, "create", "/people", "/people", values, REQUIRES_ORG);
  }

  const result = await createPerson(db, profile, {
    firstName: values.firstName,
    lastName: values.lastName,
    email: nullable(values.email),
    title: nullable(values.title),
    phone: nullable(values.phone),
    orgId,
  });
  if (result.ok) return c.redirect(`/people/${result.value}?saved=created`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return personForm(c, db, profile, "create", "/people", "/people", values, result.reason);
});

app.get("/people/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  const person = await loadPerson(db, id);
  if (!person) return notFound(c, profile);

  const [roster, activities] = await Promise.all([
    loadRoster(db),
    loadActivities(db, { personId: id, limit: 30 }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      `${person.firstName} ${person.lastName}`,
      <PersonDetailPage
        person={person}
        activities={activities}
        roster={rosterIndex(roster)}
        now={now()}
        canWrite={canCreateRecords(membershipOf(profile))}
        flash={flashOf(c)}
      />,
    ),
  );
});

app.get("/people/:id/edit", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  const person = await loadPerson(db, id);
  if (!person) return notFound(c, profile);

  return personForm(c, db, profile, "edit", `/people/${id}`, `/people/${id}`, {
    firstName: person.firstName,
    lastName: person.lastName,
    email: person.email ?? "",
    title: person.title ?? "",
    phone: person.phone ?? "",
    orgId: person.orgId,
  });
});

app.post("/people/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);

  const form = await c.req.formData();
  const values = personValues(form);
  const orgId = reference(form, "orgId");
  const back = `/people/${id}`;
  if (!orgId) {
    return personForm(c, db, profile, "edit", back, back, values, REQUIRES_ORG);
  }

  const result = await updatePerson(db, id, {
    firstName: values.firstName,
    lastName: values.lastName,
    email: nullable(values.email),
    title: nullable(values.title),
    phone: nullable(values.phone),
    orgId,
  });
  if (result.ok) return c.redirect(`${back}?saved=updated`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return personForm(c, db, profile, "edit", back, back, values, result.reason);
});

app.get("/deals/board", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const [roster, deals] = await Promise.all([loadRoster(db), loadDeals(db)]);

  return page(
    c,
    shell(
      c,
      profile,
      "Pipeline",
      <BoardPage
        columns={boardOf(deals)}
        roster={rosterIndex(roster)}
        moves={new Map(deals.map((d) => [d.id, movesFor(profile, d)]))}
        canCreate={canCreateDeal(membershipOf(profile), true)}
        flash={flashOf(c)}
      />,
    ),
  );
});

app.get("/deals", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const stageRaw = c.req.query("stage") ?? "";
  const stage = (DEAL_STAGES as readonly string[]).includes(stageRaw)
    ? (stageRaw as DealStage)
    : undefined;
  const ownerRaw = c.req.query("owner") ?? "";
  const ownerId = isUuid(ownerRaw) ? ownerRaw : undefined;

  const [roster, deals] = await Promise.all([
    loadRoster(db),
    loadDeals(db, { stage, ownerId }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      "Deals",
      <DealListPage
        deals={deals}
        roster={rosterIndex(roster)}
        stage={stage ?? ""}
        ownerId={ownerId ?? ""}
        canCreate={canCreateDeal(membershipOf(profile), true)}
      />,
    ),
  );
});

// ----------------------------------------------------- deals: create / edit

const dealValues = (form: FormData): DealValues => ({
  name: field(form, "name"),
  amount: field(form, "amount"),
  orgId: field(form, "orgId"),
  ownerId: field(form, "ownerId"),
});

const dealForm = async (
  c: AppContext,
  db: AuthVars["db"],
  profile: CrmProfile,
  mode: "create" | "edit",
  action: string,
  cancelHref: string,
  values: DealValues,
  error?: string,
) => {
  const [orgs, roster] = await Promise.all([loadOrgs(db), loadRoster(db)]);
  return page(
    c,
    shell(
      c,
      profile,
      mode === "edit" ? "Edit deal" : "New deal",
      <DealFormPage
        mode={mode}
        action={action}
        cancelHref={cancelHref}
        orgs={orgs}
        owners={roster.filter((m) => m.active)}
        // "may this reader own it for someone else?" is the domain
        // module's question, and the INSERT/UPDATE policies answer it
        // again independently on the write itself.
        canChooseOwner={canCreateDeal(membershipOf(profile), false)}
        selfName={profile.membership.displayName}
        values={values}
        error={error}
      />,
    ),
    error ? 400 : 200,
  );
};

const REQUIRES_ORG_DEAL = "Choose an organization for this deal.";
const REQUIRES_OWNER = "Choose an owner for this deal.";

app.get("/deals/new", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;
  if (!canCreateDeal(membershipOf(profile), true)) {
    return refused(c, profile, "Your role does not create deals in this tenant.");
  }
  const preset = c.req.query("org") ?? "";
  return dealForm(
    c,
    db,
    profile,
    "create",
    "/deals",
    isUuid(preset) ? `/organizations/${preset}` : "/deals",
    {
      name: "",
      amount: "",
      orgId: isUuid(preset) ? preset : "",
      // a rep's own id is the only owner their INSERT policy will accept;
      // the form shows it read-only and the database is what insists
      ownerId: profile.userId,
    },
  );
});

app.post("/deals", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const form = await c.req.formData();
  const values = dealValues(form);
  const orgId = reference(form, "orgId");
  const ownerId = reference(form, "ownerId");
  if (!orgId) {
    return dealForm(c, db, profile, "create", "/deals", "/deals", values, REQUIRES_ORG_DEAL);
  }
  if (!ownerId) {
    return dealForm(c, db, profile, "create", "/deals", "/deals", values, REQUIRES_OWNER);
  }

  const result = await createDeal(db, profile, {
    name: values.name,
    amount: Number(values.amount),
    orgId,
    ownerId,
  });
  if (result.ok) return c.redirect(`/deals/${result.value}?saved=created`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return dealForm(c, db, profile, "create", "/deals", "/deals", values, result.reason);
});

/**
 * The deal page, rendered by its own GET and again by any write against
 * the deal that the database refused — so a refusal lands on the record it
 * is about, with the reason attached, rather than on a bare error screen.
 */
const dealPage = async (
  c: AppContext,
  db: AuthVars["db"],
  profile: CrmProfile,
  id: string,
  extra: { error?: string; status?: PageStatus } = {},
): Promise<Response> => {
  const deal = await loadDeal(db, id);
  if (!deal) return notFound(c, profile);

  // The audit log is admin-eyes-only BY POLICY, so this query is made for
  // every reader and simply returns zero rows for most of them. Asking
  // regardless is what lets the page say "the database was asked and
  // declined" and have that be true (honest capture, track law 5).
  const historyVisible = canReadAuditLog(membershipOf(profile));
  const [roster, history, activities] = await Promise.all([
    loadRoster(db),
    loadDealHistory(db, id),
    loadActivities(db, { dealId: id, limit: 30 }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      deal.name,
      <DealDetailPage
        deal={deal}
        history={history}
        historyVisible={historyVisible}
        activities={activities}
        roster={rosterIndex(roster)}
        now={now()}
        moves={movesFor(profile, deal)}
        canEdit={canUpdateDeal(membershipOf(profile), deal.ownerId === profile.userId)}
        canReopen={canReopenDeal(membershipOf(profile))}
        closed={isTerminalStage(deal.stage)}
        flash={flashOf(c)}
        error={extra.error}
      />,
    ),
    extra.status ?? 200,
  );
};

app.get("/deals/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  return dealPage(c, db, profile, id);
});

app.get("/deals/:id/edit", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  const deal = await loadDeal(db, id);
  if (!deal) return notFound(c, profile);

  // Wayfinding only. The reader can already SEE this deal — declining to
  // render its form is tidiness, and the UPDATE policy is what would
  // refuse the write if they posted one anyway (they may: see below).
  if (!canUpdateDeal(membershipOf(profile), deal.ownerId === profile.userId)) {
    return refused(
      c,
      profile,
      "Reps work the deals they own. This one belongs to another member's book — a manager or tenant admin can edit it, and the database enforces that whether or not this page renders a form.",
    );
  }

  return dealForm(c, db, profile, "edit", `/deals/${id}`, `/deals/${id}`, {
    name: deal.name,
    amount: String(deal.amount),
    orgId: deal.orgId,
    ownerId: deal.ownerId,
  });
});

app.post("/deals/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);

  const form = await c.req.formData();
  const values = dealValues(form);
  const ownerId = reference(form, "ownerId");
  const back = `/deals/${id}`;
  if (!ownerId) {
    return dealForm(c, db, profile, "edit", back, back, values, REQUIRES_OWNER);
  }

  // NOTE what is absent: no ownership check before the write. A crafted
  // post against another member's deal reaches the database and is
  // refused there — zero rows, silently, exactly like a denied read.
  const result = await updateDeal(db, id, {
    name: values.name,
    amount: Number(values.amount),
    orgId: values.orgId,
    ownerId,
  });
  if (result.ok) return c.redirect(`${back}?saved=updated`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return dealForm(c, db, profile, "edit", back, back, values, result.reason);
});

/**
 * A stage move. The stage is checked for MEMBERSHIP OF THE VOCABULARY and
 * nothing else — whether the move is legal from where the deal stands, and
 * whether this reader may make it at all, are both the database's to
 * answer. That is what makes a crafted request meet the same refusal as a
 * mis-rendered form, and it is the invariant test/writes.test.ts pins.
 */
app.post("/deals/:id/stage", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);

  const requested = field(await c.req.formData(), "stage");
  if (!(DEAL_STAGES as readonly string[]).includes(requested)) {
    return dealPage(c, db, profile, id, {
      error: "That is not a stage this pipeline has.",
      status: 400,
    });
  }

  const result = await setDealStage(db, id, requested as DealStage);
  if (result.ok) return c.redirect(`/deals/${id}?saved=stage`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return dealPage(c, db, profile, id, { error: result.reason, status: 400 });
});

/** The audited exit from won/lost — role-checked and reasoned in the RPC. */
app.post("/deals/:id/reopen", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);

  const reason = field(await c.req.formData(), "reason");
  const result = await reopenDeal(db, id, reason);
  if (result.ok) return c.redirect(`/deals/${id}?saved=reopened`, 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return dealPage(c, db, profile, id, { error: result.reason, status: 400 });
});

app.get("/activities", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const typeRaw = c.req.query("type") ?? "";
  const type = isActivityType(typeRaw) ? (typeRaw as Activity["type"]) : undefined;
  const authorRaw = c.req.query("author") ?? "";
  const authorId = isUuid(authorRaw) ? authorRaw : undefined;

  const [roster, activities] = await Promise.all([
    loadRoster(db),
    loadActivities(db, { type, authorId, limit: 100 }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      "Activity",
      <ActivityPage
        activities={activities}
        roster={rosterIndex(roster)}
        type={type ?? ""}
        authorId={authorId ?? ""}
        now={now()}
        canCreate={canCreateRecords(membershipOf(profile))}
        flash={flashOf(c)}
      />,
    ),
  );
});

// ------------------------------------------------------- activities: create

const activityValues = (form: FormData): ActivityValues => ({
  type: field(form, "type"),
  subject: field(form, "subject"),
  body: String(form.get("body") ?? ""),
  orgId: field(form, "orgId"),
  personId: field(form, "personId"),
  dealId: field(form, "dealId"),
});

const activityForm = async (
  c: AppContext,
  db: AuthVars["db"],
  profile: CrmProfile,
  cancelHref: string,
  values: ActivityValues,
  error?: string,
) => {
  const [orgs, people, deals] = await Promise.all([
    loadOrgs(db),
    loadPeople(db),
    loadDeals(db),
  ]);
  return page(
    c,
    shell(
      c,
      profile,
      "Log activity",
      <ActivityFormPage
        action="/activities"
        cancelHref={cancelHref}
        orgs={orgs}
        people={people}
        deals={deals}
        values={values}
        error={error}
      />,
    ),
    error ? 400 : 200,
  );
};

app.get("/activities/new", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;
  if (!canCreateRecords(membershipOf(profile))) {
    return refused(c, profile, "Your role does not log activity in this tenant.");
  }

  // The link a visitor arrived with is a PRESELECTION, not a claim: an id
  // for another tenant's record simply fails to match any option, and the
  // composite foreign key would refuse it even if it did.
  const org = c.req.query("org") ?? "";
  const person = c.req.query("person") ?? "";
  const deal = c.req.query("deal") ?? "";
  const cancelHref = isUuid(deal)
    ? `/deals/${deal}`
    : isUuid(person)
      ? `/people/${person}`
      : isUuid(org)
        ? `/organizations/${org}`
        : "/activities";

  return activityForm(c, db, profile, cancelHref, {
    // the first kind in the vocabulary, not a hand-picked favourite
    type: ACTIVITY_TYPES[0],
    subject: "",
    body: "",
    orgId: isUuid(org) ? org : "",
    personId: isUuid(person) ? person : "",
    dealId: isUuid(deal) ? deal : "",
  });
});

app.post("/activities", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const form = await c.req.formData();
  const values = activityValues(form);
  if (!isActivityType(values.type)) {
    return activityForm(c, db, profile, "/activities", values, "Choose a kind of activity.");
  }

  const result = await logActivity(db, profile, {
    type: values.type,
    subject: values.subject,
    body: nullable(values.body),
    orgId: reference(form, "orgId"),
    personId: reference(form, "personId"),
    dealId: reference(form, "dealId"),
  });
  if (result.ok) {
    // back to the record it was logged against, where the trail now shows it
    const target = isUuid(values.dealId)
      ? `/deals/${values.dealId}`
      : isUuid(values.personId)
        ? `/people/${values.personId}`
        : isUuid(values.orgId)
          ? `/organizations/${values.orgId}`
          : "/activities";
    return c.redirect(`${target}?saved=logged`, 303);
  }
  if (result.kind === "missing") return writeRefused(c, profile);
  return activityForm(c, db, profile, "/activities", values, result.reason);
});

// ------------------------------------------------------------ reports
//
// The manager beat. Three rollups over this tenant's own rows, computed in
// the Worker at page load from what the reader's JWT was given — there is
// no reporting table, no cache and no scheduled aggregate anywhere in this
// app, which is what lets the reconciliation spot-check trace a rendered
// number back to a seeded one exactly.

/**
 * The activity-volume window. Four weeks, because that is the span the
 * scenario data actually covers — a longer window is not more informative,
 * it is a row of empty columns that reads like a business in decline. If
 * the seed's trails ever stretch further back, widen this to match them.
 */
const ACTIVITY_WEEKS = 4;

app.get("/reports", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  // Wayfinding, and the page below says as much: the rows behind these
  // rollups are readable by every member of the tenant, so this refusal
  // tidies a demo rather than keeping a secret. The secrets — another
  // tenant's rows, this tenant's audit trail — are the database's.
  if (!canReadReports(membershipOf(profile))) {
    return refused(
      c,
      profile,
      "The rollups are a manager surface. Your role reads the same deals and activities one at a time — the pipeline, the deal list and the activity feed are all yours — but this summary is not offered to it.",
    );
  }

  const asOf = now();
  const [roster, deals, pulse] = await Promise.all([
    loadRoster(db),
    loadDealsForReport(db),
    loadActivityPulse(db, new Date(asOf.getTime() - ACTIVITY_WEEKS * WEEK_MS).toISOString()),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      "Reports",
      <ReportsPage
        tenantName={profile.tenant.name}
        now={asOf}
        deals={deals.rows}
        dealsTotal={deals.total}
        dealsComplete={deals.complete}
        volume={activityByWeek(pulse.rows, asOf, ACTIVITY_WEEKS)}
        activityTotal={pulse.total}
        activityComplete={pulse.complete}
        weeks={ACTIVITY_WEEKS}
        roster={rosterIndex(roster)}
      />,
    ),
  );
});

// ------------------------------------------------------------ tenant admin
//
// Governance, not provisioning: no account is created here (self-signup is
// disabled and the seed provisions them), and the two acts that exist are
// RPCs which check the caller's role, refuse a self-act and write their own
// audit row. The guard below decides what is OFFERED; every one of these
// handlers would be refused by the database if it were reached anyway.

const adminPage = async (
  c: AppContext,
  db: AuthVars["db"],
  profile: CrmProfile,
  extra: { error?: string; status?: PageStatus } = {},
): Promise<Response> => {
  const roster = await loadRoster(db);
  return page(
    c,
    shell(
      c,
      profile,
      "Users",
      <AdminUsersPage
        members={sortedRoster(roster)}
        selfUserId={profile.userId}
        tenantName={profile.tenant.name}
        flash={flashOf(c)}
        error={extra.error}
      />,
    ),
    extra.status ?? 200,
  );
};

/** Active first, then by name — a deactivated row is a footnote, not a hole. */
const sortedRoster = (members: Member[]): Member[] =>
  [...members].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.displayName.localeCompare(b.displayName),
  );

/** The admin surfaces' one guard. Wayfinding; the RPCs refuse independently. */
const adminRefusal = async (c: AppContext, profile: CrmProfile): Promise<Response | null> =>
  canManageMemberships(membershipOf(profile))
    ? null
    : refused(
        c,
        profile,
        "Membership administration belongs to the tenant admin. Your role can see who is on the team — every member can — but changing a role or switching an account off is an admin act, and the database refuses it to anyone else whether or not this page renders a control.",
      );

app.get("/admin/users", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const denied = await adminRefusal(c, profile);
  if (denied) return denied;
  return adminPage(c, db, profile);
});

app.post("/admin/users/:userId/role", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const denied = await adminRefusal(c, profile);
  if (denied) return denied;

  const userId = c.req.param("userId");
  if (!isUuid(userId)) return notFound(c, profile);

  // Vocabulary only — WHICH roles this caller may hand out, and to whom, is
  // membership_set_role's answer, given inside the transaction that would
  // make the change.
  const requested = field(await c.req.formData(), "role");
  if (!isMemberRole(requested)) {
    return adminPage(c, db, profile, {
      error: "That is not a role this tenant has.",
      status: 400,
    });
  }

  const result = await setMembershipRole(db, profile, userId, requested);
  if (result.ok) return c.redirect("/admin/users?saved=role", 303);
  if (result.kind === "missing") return writeRefused(c, profile);
  return adminPage(c, db, profile, { error: result.reason, status: 400 });
});

/**
 * Deactivate and reactivate are separate routes rather than one taking a
 * boolean, for the reason the stage move and the reopen are separate: a
 * mangled or crafted value must never be able to mean "switch this person
 * off" by accident. Each route says one thing.
 */
const setAccess = async (c: AppContext, active: boolean): Promise<Response> => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const denied = await adminRefusal(c, profile);
  if (denied) return denied;

  const userId = c.req.param("userId");
  if (!isUuid(userId)) return notFound(c, profile);

  const result = await setMembershipActive(db, profile, userId, active);
  if (result.ok) {
    return c.redirect(`/admin/users?saved=${active ? "activated" : "deactivated"}`, 303);
  }
  if (result.kind === "missing") return writeRefused(c, profile);
  return adminPage(c, db, profile, { error: result.reason, status: 400 });
};

app.post("/admin/users/:userId/activate", (c) => setAccess(c, true));
app.post("/admin/users/:userId/deactivate", (c) => setAccess(c, false));

// ------------------------------------------------------------ audit trail

/**
 * The tenant's audit trail — the "enterprise audit" demo beat, and the
 * surface the day-in-the-life walk is checked against.
 *
 * The query runs for EVERY signed-in reader, not only admins. The policy
 * returns zero rows to everyone else, which is the point: the page can
 * honestly say it asked the database with this reader's own sign-in and
 * was given nothing. A role check that skipped the query would make that
 * sentence a lie about software that never ran.
 */
/**
 * A cap, and the page says so rather than claiming completeness it does
 * not have. Paging the long surfaces is crm-demo#15; until then the
 * honest move is to name the limit, not to hide behind it.
 */
const AUDIT_PAGE_LIMIT = 200;

app.get("/audit", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const [roster, entries] = await Promise.all([
    loadRoster(db),
    loadAuditFeed(db, { limit: AUDIT_PAGE_LIMIT }),
  ]);

  return page(
    c,
    shell(
      c,
      profile,
      "Audit trail",
      <AuditPage
        entries={entries}
        roster={rosterIndex(roster)}
        canRead={canReadAuditLog(membershipOf(profile))}
        tenantName={profile.tenant.name}
        limit={AUDIT_PAGE_LIMIT}
      />,
    ),
  );
});

// ------------------------------------------------------------ fallbacks

app.notFound((c) => {
  const profile = c.get("profile");
  if (!profile) return c.redirect("/login", 302);
  return notFound(c as AppContext, profile);
});

app.onError((err, c) => {
  console.error("request failed", { path: new URL(c.req.url).pathname, error: String(err) });
  const profile = c.get("profile");
  const detail =
    err instanceof ReadFailed
      ? "A read failed against the database. Nothing partial has been rendered — this page is empty because the query errored, not because your tenant has no data."
      : "The request could not be completed.";
  const node = profile
    ? shell(c as AppContext, profile, "Error", <ErrorPage detail={detail} />)
    : publicPage(c as AppContext, "Error", <ErrorPage detail={detail} />);
  return page(c as AppContext, node, 500);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids arrive from the URL. A malformed one is a 404 here rather than a
 * database error there — the database would refuse it anyway; this just
 * keeps the refusal readable.
 */
function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Unused by request handling; exported so tests can name the surface. */
export const ROUTES = [
  "/healthz",
  "/app.css",
  "/login",
  "/logout",
  "/",
  "/organizations",
  "/organizations/new",
  "/organizations/:id",
  "/organizations/:id/edit",
  "/people",
  "/people/new",
  "/people/:id",
  "/people/:id/edit",
  "/deals",
  "/deals/board",
  "/deals/new",
  "/deals/:id",
  "/deals/:id/edit",
  "/deals/:id/stage",
  "/deals/:id/reopen",
  "/activities",
  "/activities/new",
  "/reports",
  "/audit",
  "/admin/users",
  "/admin/users/:userId/role",
  "/admin/users/:userId/activate",
  "/admin/users/:userId/deactivate",
  "/demo",
] as const;

export default app;
