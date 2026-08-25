// Page chrome. Two shells: the signed-in Shell (banner, identity, nav) and
// the signed-out PublicShell (banner, no nav, no identity). The
// synthetic-data banner is part of BOTH — it is not a component a page may
// choose to leave out, because "this is a demo with made-up data" is a
// claim the studio has to make on every screen (track law 5).

import type { Child } from "hono/jsx";

import type { CrmProfile } from "../env";
import {
  canManageMemberships,
  canReadAuditLog,
  canReadReports,
  type Membership,
} from "../domain/roles";
import { ROLE_LABEL } from "../views/format";
import { BANNER_TEXT, resetBanner } from "../views/demo";

export { ROLE_LABEL, BANNER_TEXT };

/**
 * `see` is an AFFORDANCE predicate, not a gate. Two of these routes are
 * reachable by anyone signed in and simply hand back nothing useful
 * (/audit reads zero rows for a non-admin because the policy says so);
 * two answer 403 in the router as wayfinding. Neither is what keeps
 * anything private — hiding a link keeps a demo tidy, and that is all.
 */
const NAV: { href: string; label: string; see: (m: Membership) => boolean }[] = [
  { href: "/", label: "Overview", see: () => true },
  { href: "/organizations", label: "Organizations", see: () => true },
  { href: "/people", label: "People", see: () => true },
  { href: "/deals", label: "Deals", see: () => true },
  { href: "/deals/board", label: "Pipeline", see: () => true },
  { href: "/activities", label: "Activity", see: () => true },
  { href: "/reports", label: "Reports", see: canReadReports },
  { href: "/audit", label: "Audit trail", see: canReadAuditLog },
  { href: "/admin/users", label: "Users", see: canManageMemberships },
];

/** The nav item a path belongs to — longest matching prefix, "/" exact. */
export const currentNav = (path: string): string => {
  if (path === "/") return "/";
  const match = NAV.filter((n) => n.href !== "/" && path.startsWith(n.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.href ?? "";
};

/**
 * The synthetic-data banner. Its second sentence is NOT written here: the
 * reset posture comes from src/views/demo.ts, so this banner and the
 * public credentials page cannot drift into telling a visitor two
 * different stories about when their changes go away. Until the reset job
 * ships (CRMDEMO-EPIC1-06) both of them say so.
 */
function Banner() {
  return (
    <div class="banner" role="note">
      <div class="banner-inner">
        <strong>Demo environment</strong> — every organization, person and deal here is synthetic.{" "}
        {resetBanner()} <a href="/demo">Demo logins and posture →</a>
      </div>
    </div>
  );
}

/**
 * `noindex` on every page except the one that is deliberately findable:
 * the /demo front door (CRMDEMO-EPIC1-06; robots.txt matches — it is the
 * one path a crawler is invited to read). App pages sit behind a login
 * redirect anyway; the meta is the belt to that suspender.
 */
function Head({ title, indexable }: { title: string; indexable?: boolean }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {indexable ? null : <meta name="robots" content="noindex" />}
      <title>{title} · CRM Demo</title>
      <link rel="stylesheet" href="/app.css" />
    </head>
  );
}

function Footer({ buildId }: { buildId: string }) {
  return (
    <footer>
      <div class="footer-inner">
        <span>
          CRM Demo — a live demonstration build of the{" "}
          <a href="https://bussetech.com">Bussetech Software Studio</a>. Synthetic data only;
          no availability or durability commitments.
        </span>
        <span class="mono">build {buildId}</span>
      </div>
    </footer>
  );
}

export function Shell(props: {
  title: string;
  profile: CrmProfile;
  path: string;
  buildId: string;
  children?: Child;
}) {
  const active = currentNav(props.path);
  // a session only exists for an ACTIVE membership (src/auth.ts), so the
  // affordance question is only ever about the role
  const membership: Membership = { role: props.profile.membership.role, active: true };
  const items = NAV.filter((item) => item.see(membership));
  return (
    <html lang="en">
      <Head title={props.title} />
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <Banner />
        <div class="topbar">
          <div class="topbar-inner">
            <a class="brand" href="/">
              CRM Demo
            </a>
            <div class="whoami">
              <span class="tenant-name">{props.profile.tenant.name}</span>
              <span class="muted">
                {props.profile.membership.displayName} ·{" "}
                {ROLE_LABEL[props.profile.membership.role]}
              </span>
              <form method="post" action="/logout">
                <button type="submit" class="linklike">
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
        <nav class="nav" aria-label="Sections">
          <div class="nav-inner">
            {items.map((item) => (
              <a href={item.href} aria-current={item.href === active ? "page" : undefined}>
                {item.label}
              </a>
            ))}
          </div>
        </nav>
        <main id="main">{props.children}</main>
        <Footer buildId={props.buildId} />
      </body>
    </html>
  );
}

export function PublicShell(props: {
  title: string;
  buildId: string;
  indexable?: boolean;
  children?: Child;
}) {
  return (
    <html lang="en">
      <Head title={props.title} indexable={props.indexable} />
      <body>
        <Banner />
        <main id="main">{props.children}</main>
        <Footer buildId={props.buildId} />
      </body>
    </html>
  );
}

export function PageHead(props: { title: string; sub?: string; children?: Child }) {
  return (
    <div class="page-head">
      <h1>{props.title}</h1>
      {props.sub ? <p>{props.sub}</p> : null}
      {props.children}
    </div>
  );
}

export function Empty({ what }: { what: string }) {
  return <p class="empty">No {what}.</p>;
}

/** A row of buttons/links that start a write. */
export function Actions({ children }: { children?: Child }) {
  return <div class="actions">{children}</div>;
}

export function Notice({ tone, children }: { tone: "ok" | "refusal"; children?: Child }) {
  return (
    <p
      class={tone === "refusal" ? "note refusal" : "note ok"}
      role={tone === "refusal" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

/**
 * Confirmation after a write, carried in the redirect's query string.
 *
 * A flash needs somewhere to live between the POST and the GET that
 * follows it. This app has no session store and ships no JavaScript, so
 * the redirect target says what happened — and because the message is
 * looked up by key rather than echoed, nothing a visitor types can reach
 * the page this way.
 */
export const FLASH: Record<string, string> = {
  created: "Created. The audit trail has it.",
  updated: "Saved. The audit trail has it.",
  stage: "Stage updated — the database recorded the move.",
  reopened: "Reopened. The reason is in the audit trail, against your name.",
  logged: "Activity logged.",
  role: "Role changed. The audit trail has it, against your name.",
  deactivated: "Access removed. That account can still sign in and will be told it has no access.",
  activated: "Access restored. That account can sign in again.",
};

export function Flash({ code }: { code?: string }) {
  const message = code ? FLASH[code] : undefined;
  return message ? <Notice tone="ok">{message}</Notice> : null;
}
