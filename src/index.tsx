// crm-demo — Workers entry point (Hono + SSR JSX, the stratum shape).
//
// CRMDEMO-EPIC1-03 makes the seeded world VISIBLE: sign in, then read every
// entity through the signed-in user's own JWT. There are no write paths in
// this file on purpose (04 owns them) and no service-role client anywhere
// in a request path, ever.
//
// The authorization boundary is the database. Route guards below decide
// where a request goes, never what a query may see — a guard that got it
// wrong would leak nothing, because the query still runs as the user.
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
import { canReadAuditLog } from "./domain/roles";
import { DEAL_STAGES, type DealStage } from "./domain/stages";
import { APP_CSS } from "./ui/styles";
import { PublicShell, Shell } from "./ui/layout";
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
} from "./ui/pages";
import {
  ReadFailed,
  boardOf,
  loadActivities,
  loadDeal,
  loadDealHistory,
  loadDeals,
  loadOrg,
  loadOrgs,
  loadPeople,
  loadPerson,
  loadRoster,
  rosterIndex,
  type Activity,
} from "./views/model";

export type { Env };

export const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVars> }>();

// ------------------------------------------------------------ page helpers

/** What a component renders — hono/jsx does not export a JSX.Element alias. */
type Node = HtmlEscapedString | Promise<HtmlEscapedString>;

type PageStatus = 200 | 400 | 401 | 404 | 500;

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
    shell(c, profile, "Organizations", <OrgListPage orgs={orgs} q={q} sort={sort} />),
  );
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
      />,
    ),
  );
});

app.get("/people", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const q = c.req.query("q") ?? "";
  const people = await loadPeople(db, { q });

  return page(c, shell(c, profile, "People", <PeopleListPage people={people} q={q} />));
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
      />,
    ),
  );
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
      <BoardPage columns={boardOf(deals)} roster={rosterIndex(roster)} />,
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
      />,
    ),
  );
});

app.get("/deals/:id", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const id = c.req.param("id");
  if (!isUuid(id)) return notFound(c, profile);
  const deal = await loadDeal(db, id);
  if (!deal) return notFound(c, profile);

  // The audit log is admin-eyes-only by policy. Asking as a rep returns
  // zero rows rather than an error, so the page has to know the difference
  // between "no history" and "not yours to see" — the domain twin says
  // which, and the database enforces it either way.
  const historyVisible = canReadAuditLog({ role: profile.membership.role, active: true });
  const [roster, history, activities] = await Promise.all([
    loadRoster(db),
    historyVisible ? loadDealHistory(db, id) : Promise.resolve([]),
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
      />,
    ),
  );
});

app.get("/activities", async (c) => {
  const session = requireSession(c);
  if (isResponse(session)) return session;
  const { db, profile } = session;

  const typeRaw = c.req.query("type") ?? "";
  const type = (["call", "email", "meeting", "note"] as const).includes(
    typeRaw as Activity["type"],
  )
    ? (typeRaw as Activity["type"])
    : undefined;
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
  "/organizations/:id",
  "/people",
  "/people/:id",
  "/deals",
  "/deals/board",
  "/deals/:id",
  "/activities",
] as const;

export default app;
