// The read surfaces. Every page here is a pure function of data already
// fetched through the signed-in user's JWT — no component queries, so
// there is exactly one place (src/views/model.ts) where a read can happen
// and exactly one identity it can happen as.

import type { Child } from "hono/jsx";

import { DEAL_STAGES, type DealStage } from "../domain/stages";
import type { MemberRole } from "../domain/roles";
import type {
  Activity,
  AuditEntry,
  Deal,
  Member,
  Org,
  Person,
  BoardColumn,
} from "../views/model";
import { ACTIVITY_LABEL, STAGE_LABEL, auditLine, day, fullName, money, since, stamp } from "../views/format";
import { Empty, PageHead, ROLE_LABEL } from "./layout";

type Roster = Map<string, Member>;

const memberName = (roster: Roster, userId: string | null): string =>
  (userId && roster.get(userId)?.displayName) || "—";

// ------------------------------------------------------------ small parts

export function StageBadge({ stage }: { stage: DealStage }) {
  return <span class={`stage stage-${stage}`}>{STAGE_LABEL[stage]}</span>;
}

export function RoleBadge({ role, active }: { role: MemberRole; active: boolean }) {
  return (
    <span class={`badge role-${role}${active ? "" : " inactive"}`}>
      {ROLE_LABEL[role]}
      {active ? "" : " · deactivated"}
    </span>
  );
}

function Facts({ children }: { children?: Child }) {
  return <dl class="facts">{children}</dl>;
}

function Fact({ label, children }: { label: string; children?: Child }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children?: Child }) {
  return (
    <section class="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// ------------------------------------------------------------ login

export function LoginPage(props: { error?: string; next?: string; email?: string }) {
  return (
    <div class="login">
      <h1>Sign in to CRM Demo</h1>
      <p class="muted" style="margin-top:.5rem">
        Accounts on this demo are provisioned with the scenario data — there is no sign-up,
        and no account here belongs to a real person. The published demo logins are listed
        on the studio site.
      </p>
      {props.error ? (
        <p class="note refusal" style="margin-top:1.5rem" role="alert">
          {props.error}
        </p>
      ) : null}
      <form method="post" action="/login">
        {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
        <div class="field">
          <label for="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autocomplete="username"
            required
            value={props.email ?? ""}
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------ overview

export function OverviewPage(props: {
  tenantName: string;
  orgCount: number;
  peopleCount: number;
  deals: Deal[];
  activities: Activity[];
  roster: Roster;
  now: Date;
}) {
  const open = props.deals.filter((d) => !d.closedAt);
  const openValue = open.reduce((sum, d) => sum + d.amount, 0);
  return (
    <>
      <PageHead
        title={props.tenantName}
        sub="Everything on this screen is read from the database through your own sign-in — you see your tenant and nothing else."
      />
      <div class="tiles">
        <div class="tile">
          <span class="n num">{props.orgCount}</span>
          <span class="eyebrow">Organizations</span>
        </div>
        <div class="tile">
          <span class="n num">{props.peopleCount}</span>
          <span class="eyebrow">People</span>
        </div>
        <div class="tile">
          <span class="n num">{open.length}</span>
          <span class="eyebrow">Open deals</span>
        </div>
        <div class="tile">
          <span class="n num">{money(openValue)}</span>
          <span class="eyebrow">Open pipeline</span>
        </div>
      </div>

      <Section title="Pipeline by stage">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th class="right">Deals</th>
                <th class="right">Value</th>
              </tr>
            </thead>
            <tbody>
              {DEAL_STAGES.map((stage) => {
                const inStage = props.deals.filter((d) => d.stage === stage);
                return (
                  <tr>
                    <td>
                      <a href={`/deals?stage=${stage}`}>
                        <StageBadge stage={stage} />
                      </a>
                    </td>
                    <td class="right num">{inStage.length}</td>
                    <td class="right num">
                      {money(inStage.reduce((sum, d) => sum + d.amount, 0))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Recent activity">
        <ActivityFeed activities={props.activities} roster={props.roster} now={props.now} />
        <p style="margin-top:1rem">
          <a href="/activities">All activity →</a>
        </p>
      </Section>
    </>
  );
}

// ------------------------------------------------------------ organizations

export function OrgListPage(props: { orgs: Org[]; q: string; sort: string }) {
  return (
    <>
      <PageHead title="Organizations" sub={`${props.orgs.length} shown`} />
      <form class="filters" method="get" action="/organizations">
        <div class="field">
          <label for="q">Search by name</label>
          <input id="q" name="q" type="search" value={props.q} placeholder="Name contains…" />
        </div>
        <div class="field">
          <label for="sort">Sort</label>
          <select id="sort" name="sort">
            <option value="name" selected={props.sort === "name"}>
              Name
            </option>
            <option value="city" selected={props.sort === "city"}>
              City
            </option>
            <option value="recent" selected={props.sort === "recent"}>
              Recently added
            </option>
          </select>
        </div>
        <button type="submit">Apply</button>
        {props.q || props.sort !== "name" ? (
          <a class="button quiet" href="/organizations">
            Clear
          </a>
        ) : null}
      </form>
      {props.orgs.length === 0 ? (
        <Empty what="organizations match" />
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Industry</th>
                <th>City</th>
                <th>Domain</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {props.orgs.map((o) => (
                <tr>
                  <td>
                    <a href={`/organizations/${o.id}`}>{o.name}</a>
                  </td>
                  <td>{o.industry ?? "—"}</td>
                  <td>{o.city ?? "—"}</td>
                  <td class="mono">{o.domain ?? "—"}</td>
                  <td>{day(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function OrgDetailPage(props: {
  org: Org;
  people: Person[];
  deals: Deal[];
  activities: Activity[];
  roster: Roster;
  now: Date;
}) {
  return (
    <>
      <p class="crumb">
        <a href="/organizations">← Organizations</a>
      </p>
      <PageHead title={props.org.name} />
      <div class="panel">
        <Facts>
          <Fact label="Industry">{props.org.industry ?? "—"}</Fact>
          <Fact label="City">{props.org.city ?? "—"}</Fact>
          <Fact label="Domain">
            <span class="mono">{props.org.domain ?? "—"}</span>
          </Fact>
          <Fact label="Added">{day(props.org.createdAt)}</Fact>
        </Facts>
      </div>

      <Section title={`People (${props.people.length})`}>
        {props.people.length === 0 ? (
          <Empty what="people recorded for this organization" />
        ) : (
          <PeopleTable people={props.people} showOrg={false} />
        )}
      </Section>

      <Section title={`Deals (${props.deals.length})`}>
        {props.deals.length === 0 ? (
          <Empty what="deals for this organization" />
        ) : (
          <DealTable deals={props.deals} roster={props.roster} showOrg={false} />
        )}
      </Section>

      <Section title="Recent activity">
        <ActivityFeed activities={props.activities} roster={props.roster} now={props.now} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------ people

export function PeopleTable({ people, showOrg }: { people: Person[]; showOrg: boolean }) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Title</th>
            {showOrg ? <th>Organization</th> : null}
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr>
              <td>
                <a href={`/people/${p.id}`}>{fullName(p)}</a>
              </td>
              <td>{p.title ?? "—"}</td>
              {showOrg ? (
                <td>
                  <a href={`/organizations/${p.orgId}`}>{p.orgName ?? "—"}</a>
                </td>
              ) : null}
              <td class="mono">{p.email ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PeopleListPage(props: { people: Person[]; q: string }) {
  return (
    <>
      <PageHead title="People" sub={`${props.people.length} shown`} />
      <form class="filters" method="get" action="/people">
        <div class="field">
          <label for="q">Search by name or email</label>
          <input id="q" name="q" type="search" value={props.q} placeholder="Contains…" />
        </div>
        <button type="submit">Apply</button>
        {props.q ? (
          <a class="button quiet" href="/people">
            Clear
          </a>
        ) : null}
      </form>
      {props.people.length === 0 ? (
        <Empty what="people match" />
      ) : (
        <PeopleTable people={props.people} showOrg={true} />
      )}
    </>
  );
}

export function PersonDetailPage(props: {
  person: Person;
  activities: Activity[];
  roster: Roster;
  now: Date;
}) {
  const p = props.person;
  return (
    <>
      <p class="crumb">
        <a href="/people">← People</a>
      </p>
      <PageHead title={fullName(p)} sub={p.title ?? undefined} />
      <div class="panel">
        <Facts>
          <Fact label="Organization">
            <a href={`/organizations/${p.orgId}`}>{p.orgName ?? "—"}</a>
          </Fact>
          <Fact label="Email">
            <span class="mono">{p.email ?? "—"}</span>
          </Fact>
          <Fact label="Phone">
            <span class="mono">{p.phone ?? "—"}</span>
          </Fact>
        </Facts>
      </div>
      <Section title="Activity trail">
        <ActivityFeed activities={props.activities} roster={props.roster} now={props.now} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------ deals

export function DealTable(props: { deals: Deal[]; roster: Roster; showOrg: boolean }) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Deal</th>
            {props.showOrg ? <th>Organization</th> : null}
            <th>Owner</th>
            <th>Stage</th>
            <th class="right">Amount</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {props.deals.map((d) => (
            <tr>
              <td>
                <a href={`/deals/${d.id}`}>{d.name}</a>
              </td>
              {props.showOrg ? (
                <td>
                  <a href={`/organizations/${d.orgId}`}>{d.orgName ?? "—"}</a>
                </td>
              ) : null}
              <td>{memberName(props.roster, d.ownerId)}</td>
              <td>
                <StageBadge stage={d.stage} />
              </td>
              <td class="right num">{money(d.amount)}</td>
              <td>{day(d.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DealListPage(props: {
  deals: Deal[];
  roster: Roster;
  stage: string;
  ownerId: string;
}) {
  const owners = [...props.roster.values()].filter((m) => m.active);
  return (
    <>
      <PageHead title="Deals" sub={`${props.deals.length} shown`} />
      <form class="filters" method="get" action="/deals">
        <div class="field">
          <label for="stage">Stage</label>
          <select id="stage" name="stage">
            <option value="">All stages</option>
            {DEAL_STAGES.map((s) => (
              <option value={s} selected={props.stage === s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="owner">Owner</label>
          <select id="owner" name="owner">
            <option value="">Anyone</option>
            {owners.map((m) => (
              <option value={m.userId} selected={props.ownerId === m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Apply</button>
        {props.stage || props.ownerId ? (
          <a class="button quiet" href="/deals">
            Clear
          </a>
        ) : null}
        <span style="margin-left:auto">
          <a href="/deals/board">Pipeline board →</a>
        </span>
      </form>
      {props.deals.length === 0 ? (
        <Empty what="deals match" />
      ) : (
        <DealTable deals={props.deals} roster={props.roster} showOrg={true} />
      )}
    </>
  );
}

export function BoardPage(props: { columns: BoardColumn[]; roster: Roster }) {
  const total = props.columns.reduce((sum, col) => sum + col.deals.length, 0);
  return (
    <>
      <PageHead
        title="Pipeline"
        sub={`${total} deals across every stage — including the closed ones, so the board shows the pipeline that exists rather than a flattering slice of it.`}
      />
      <div class="board">
        {props.columns.map((col) => (
          <div class={`column ${col.stage}`}>
            <header>
              <h2>{STAGE_LABEL[col.stage]}</h2>
              <div class="meta num">
                {col.deals.length} · {money(col.total)}
              </div>
            </header>
            {col.deals.length === 0 ? (
              <p class="empty">Empty</p>
            ) : (
              <div class="cards">
                {col.deals.map((d) => (
                  <div class="card">
                    <a class="title" href={`/deals/${d.id}`}>
                      {d.name}
                    </a>
                    <span class="sub">{d.orgName ?? "—"}</span>
                    <span class="sub">
                      <span class="amt num">{money(d.amount)}</span> ·{" "}
                      {memberName(props.roster, d.ownerId)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function DealDetailPage(props: {
  deal: Deal;
  history: AuditEntry[];
  historyVisible: boolean;
  activities: Activity[];
  roster: Roster;
  now: Date;
}) {
  const d = props.deal;
  return (
    <>
      <p class="crumb">
        <a href="/deals">← Deals</a> · <a href="/deals/board">Pipeline</a>
      </p>
      <PageHead title={d.name} />
      <div class="panel">
        <Facts>
          <Fact label="Organization">
            <a href={`/organizations/${d.orgId}`}>{d.orgName ?? "—"}</a>
          </Fact>
          <Fact label="Owner">{memberName(props.roster, d.ownerId)}</Fact>
          <Fact label="Stage">
            <StageBadge stage={d.stage} />
          </Fact>
          <Fact label="Amount">
            <span class="num">{money(d.amount)}</span>
          </Fact>
          <Fact label="Closed">{d.closedAt ? stamp(d.closedAt) : "Open"}</Fact>
          <Fact label="Last updated">{stamp(d.updatedAt)}</Fact>
        </Facts>
      </div>

      <Section title="Stage history">
        {props.historyVisible ? (
          props.history.length === 0 ? (
            <Empty what="recorded stage changes yet" />
          ) : (
            <ul class="trail">
              {props.history.map((h) => (
                <li>
                  <strong>{auditLine(h.action, h.detail)}</strong>{" "}
                  <span class="muted">
                    · {memberName(props.roster, h.actorId)} · {stamp(h.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p class="note">
            Stage history comes from the audit log, which this demo shows to tenant admins
            only. Your role can see the deal and its current stage, not the audit trail —
            that limit is enforced by the database, not by this page.
          </p>
        )}
      </Section>

      <Section title="Activity">
        <ActivityFeed activities={props.activities} roster={props.roster} now={props.now} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------ activities

export function ActivityFeed(props: { activities: Activity[]; roster: Roster; now: Date }) {
  if (props.activities.length === 0) return <Empty what="activity recorded" />;
  return (
    <ul class="feed">
      {props.activities.map((a) => (
        <li>
          <span class="badge">{ACTIVITY_LABEL[a.type] ?? a.type}</span>{" "}
          <span class="subject">{a.subject}</span>
          <div class="meta">
            {since(a.occurredAt, props.now)} · {day(a.occurredAt)} ·{" "}
            {memberName(props.roster, a.createdBy)}
            {a.orgId ? (
              <>
                {" · "}
                <a href={`/organizations/${a.orgId}`}>{a.orgName}</a>
              </>
            ) : null}
            {a.personId ? (
              <>
                {" · "}
                <a href={`/people/${a.personId}`}>{a.personName}</a>
              </>
            ) : null}
            {a.dealId ? (
              <>
                {" · "}
                <a href={`/deals/${a.dealId}`}>{a.dealName}</a>
              </>
            ) : null}
          </div>
          {a.body ? <p class="muted">{a.body}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function ActivityPage(props: {
  activities: Activity[];
  roster: Roster;
  type: string;
  authorId: string;
  now: Date;
}) {
  const authors = [...props.roster.values()];
  return (
    <>
      <PageHead title="Activity" sub={`${props.activities.length} most recent, newest first`} />
      <form class="filters" method="get" action="/activities">
        <div class="field">
          <label for="type">Type</label>
          <select id="type" name="type">
            <option value="">All types</option>
            {["call", "email", "meeting", "note"].map((t) => (
              <option value={t} selected={props.type === t}>
                {ACTIVITY_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="author">Logged by</label>
          <select id="author" name="author">
            <option value="">Anyone</option>
            {authors.map((m) => (
              <option value={m.userId} selected={props.authorId === m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Apply</button>
        {props.type || props.authorId ? (
          <a class="button quiet" href="/activities">
            Clear
          </a>
        ) : null}
      </form>
      <ActivityFeed activities={props.activities} roster={props.roster} now={props.now} />
    </>
  );
}

// ------------------------------------------------------------ errors

export function NotFoundPage() {
  return (
    <>
      <PageHead
        title="Not found"
        sub="No record here — either it does not exist, or it belongs to a tenant that is not yours. This app does not distinguish between the two."
      />
      <p>
        <a href="/">Back to the overview</a>
      </p>
    </>
  );
}

export function ErrorPage({ detail }: { detail: string }) {
  return (
    <>
      <PageHead title="Something went wrong" />
      <p class="note refusal">{detail}</p>
      <p style="margin-top:1rem">
        <a href="/">Back to the overview</a>
      </p>
    </>
  );
}
