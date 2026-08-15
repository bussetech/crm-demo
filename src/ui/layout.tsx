// Page chrome. Two shells: the signed-in Shell (banner, identity, nav) and
// the signed-out PublicShell (banner, no nav, no identity). The
// synthetic-data banner is part of BOTH — it is not a component a page may
// choose to leave out, because "this is a demo with made-up data" is a
// claim the studio has to make on every screen (track law 5).

import type { Child } from "hono/jsx";

import type { CrmProfile } from "../env";
import { canReadAuditLog } from "../domain/roles";
import { ROLE_LABEL } from "../views/format";

export { ROLE_LABEL };

export const BANNER_TEXT = "Demo environment — synthetic data, resets on schedule.";

/**
 * `adminOnly` is an AFFORDANCE flag, not a gate: /audit is reachable by
 * anyone signed in, and reads zero rows for anyone who is not an admin
 * because the policy says so. Hiding the link keeps a demo tidy; it is not
 * what keeps the trail private.
 */
const NAV = [
  { href: "/", label: "Overview", adminOnly: false },
  { href: "/organizations", label: "Organizations", adminOnly: false },
  { href: "/people", label: "People", adminOnly: false },
  { href: "/deals", label: "Deals", adminOnly: false },
  { href: "/deals/board", label: "Pipeline", adminOnly: false },
  { href: "/activities", label: "Activity", adminOnly: false },
  { href: "/audit", label: "Audit trail", adminOnly: true },
] as const;

/** The nav item a path belongs to — longest matching prefix, "/" exact. */
export const currentNav = (path: string): string => {
  if (path === "/") return "/";
  const match = NAV.filter((n) => n.href !== "/" && path.startsWith(n.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.href ?? "";
};

function Banner() {
  return (
    <div class="banner" role="note">
      <div class="banner-inner">
        <strong>Demo environment</strong> — every organization, person and deal here is
        synthetic. Data resets to the scenario baseline on a schedule; anything you change
        is temporary and visible to everyone using this tenant.
      </div>
    </div>
  );
}

function Head({ title }: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
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
  const seesAudit = canReadAuditLog({ role: props.profile.membership.role, active: true });
  const items = NAV.filter((item) => !item.adminOnly || seesAudit);
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

export function PublicShell(props: { title: string; buildId: string; children?: Child }) {
  return (
    <html lang="en">
      <Head title={props.title} />
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
};

export function Flash({ code }: { code?: string }) {
  const message = code ? FLASH[code] : undefined;
  return message ? <Notice tone="ok">{message}</Notice> : null;
}
