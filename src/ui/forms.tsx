// The write surfaces (CRMDEMO-EPIC1-04).
//
// Same rule as the read pages: every component here is a pure function of
// data already fetched, and no component queries. Two rules of its own:
//
//  * Forms ship NO client-side JavaScript — the CSP has no script source
//    at all (src/index.tsx), so everything is a plain form post. A select
//    of legal stage moves is server-rendered per deal.
//  * Affordances come from the domain modules, never from a comparison
//    written here. What the page OFFERS and what the database PERMITS are
//    two separate answers to the same question, and this file only knows
//    the first one.

import type { Child } from "hono/jsx";

import { ACTIVITY_TYPES } from "../domain/activity";
import { ACTIVITY_BODY_MAX } from "../domain/validation";
import type { DealStage } from "../domain/stages";
import type { AuditEntry, Deal, Member, Org, Person } from "../views/model";
import {
  ACTIVITY_LABEL,
  STAGE_LABEL,
  auditHref,
  auditLine,
  auditTarget,
  fullName,
  stamp,
} from "../views/format";
import { Empty, Notice, PageHead } from "./layout";

type Roster = Map<string, Member>;

const memberName = (roster: Roster, userId: string | null): string =>
  (userId && roster.get(userId)?.displayName) || "—";

// ------------------------------------------------------------ field parts

function Field(props: {
  name: string;
  label: string;
  value?: string;
  type?: string;
  required?: boolean;
  maxlength?: number;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value ?? ""}
        required={props.required ? true : undefined}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
      />
      {props.hint ? <span class="hint">{props.hint}</span> : null}
    </div>
  );
}

function SelectField(props: {
  name: string;
  label: string;
  value?: string;
  required?: boolean;
  blank?: string;
  hint?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      <select id={props.name} name={props.name} required={props.required ? true : undefined}>
        {props.blank ? <option value="">{props.blank}</option> : null}
        {props.options.map((o) => (
          <option value={o.value} selected={props.value === o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint ? <span class="hint">{props.hint}</span> : null}
    </div>
  );
}

function FormShell(props: {
  title: string;
  sub?: string;
  action: string;
  error?: string;
  submit: string;
  cancelHref: string;
  children?: Child;
}) {
  return (
    <>
      <p class="crumb">
        <a href={props.cancelHref}>← Back</a>
      </p>
      <PageHead title={props.title} sub={props.sub} />
      {props.error ? <Notice tone="refusal">{props.error}</Notice> : null}
      <form class="entry" method="post" action={props.action}>
        {props.children}
        <div class="actions">
          <button type="submit">{props.submit}</button>
          <a class="button quiet" href={props.cancelHref}>
            Cancel
          </a>
        </div>
      </form>
    </>
  );
}

const orgOptions = (orgs: Org[]) => orgs.map((o) => ({ value: o.id, label: o.name }));

// ------------------------------------------------------------ organization

export type OrgValues = { name: string; domain: string; industry: string; city: string };

export function OrgFormPage(props: {
  mode: "create" | "edit";
  action: string;
  cancelHref: string;
  values: OrgValues;
  error?: string;
}) {
  const editing = props.mode === "edit";
  return (
    <FormShell
      title={editing ? `Edit ${props.values.name}` : "New organization"}
      sub={
        editing
          ? undefined
          : "It lands in your tenant and nobody else's — the database sets the scope from your sign-in, not from this form."
      }
      action={props.action}
      error={props.error}
      submit={editing ? "Save organization" : "Create organization"}
      cancelHref={props.cancelHref}
    >
      <Field name="name" label="Name" value={props.values.name} required maxlength={120} />
      <Field
        name="domain"
        label="Domain"
        value={props.values.domain}
        maxlength={120}
        placeholder="example.com"
        hint="Optional. Lowercase, no scheme, no path."
      />
      <Field name="industry" label="Industry" value={props.values.industry} maxlength={80} />
      <Field name="city" label="City" value={props.values.city} maxlength={80} />
    </FormShell>
  );
}

// ------------------------------------------------------------ person

export type PersonValues = {
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  phone: string;
  orgId: string;
};

export function PersonFormPage(props: {
  mode: "create" | "edit";
  action: string;
  cancelHref: string;
  orgs: Org[];
  values: PersonValues;
  error?: string;
}) {
  const editing = props.mode === "edit";
  return (
    <FormShell
      title={editing ? `Edit ${props.values.firstName} ${props.values.lastName}` : "New contact"}
      action={props.action}
      error={props.error}
      submit={editing ? "Save contact" : "Create contact"}
      cancelHref={props.cancelHref}
    >
      <Field name="firstName" label="First name" value={props.values.firstName} required maxlength={60} />
      <Field name="lastName" label="Last name" value={props.values.lastName} required maxlength={60} />
      <SelectField
        name="orgId"
        label="Organization"
        value={props.values.orgId}
        required
        blank="Choose an organization…"
        options={orgOptions(props.orgs)}
        hint="Only your tenant's organizations are listed, and only they can be linked."
      />
      <Field name="email" label="Email" value={props.values.email} type="email" maxlength={120} />
      <Field name="title" label="Title" value={props.values.title} maxlength={80} />
      <Field name="phone" label="Phone" value={props.values.phone} maxlength={40} />
    </FormShell>
  );
}

// ------------------------------------------------------------ deal

export type DealValues = { name: string; amount: string; orgId: string; ownerId: string };

export function DealFormPage(props: {
  mode: "create" | "edit";
  action: string;
  cancelHref: string;
  orgs: Org[];
  owners: Member[];
  /** the domain module's answer, not this page's */
  canChooseOwner: boolean;
  selfName: string;
  values: DealValues;
  error?: string;
}) {
  const editing = props.mode === "edit";
  return (
    <FormShell
      title={editing ? `Edit ${props.values.name}` : "New deal"}
      sub={
        editing
          ? "The organization is fixed once a deal exists — the database refuses to move one, so recreate instead."
          : "Every deal is born at Lead. The pipeline is walked, never skipped."
      }
      action={props.action}
      error={props.error}
      submit={editing ? "Save deal" : "Create deal"}
      cancelHref={props.cancelHref}
    >
      <Field name="name" label="Deal name" value={props.values.name} required maxlength={160} />
      <Field
        name="amount"
        label="Amount (USD)"
        value={props.values.amount}
        type="number"
        required
        hint="Zero or more."
      />
      {editing ? null : (
        <SelectField
          name="orgId"
          label="Organization"
          value={props.values.orgId}
          required
          blank="Choose an organization…"
          options={orgOptions(props.orgs)}
        />
      )}
      {props.canChooseOwner ? (
        <SelectField
          name="ownerId"
          label="Owner"
          value={props.values.ownerId}
          required
          options={props.owners.map((m) => ({ value: m.userId, label: m.displayName }))}
          hint="Managers and admins may assign to anyone active in the tenant."
        />
      ) : (
        <div class="field">
          <label>Owner</label>
          <p class="static-value">
            {props.selfName}
            <span class="hint">
              A rep owns the deals they create. Assigning to someone else is a manager or admin
              act, and the database is what refuses it.
            </span>
          </p>
          <input type="hidden" name="ownerId" value={props.values.ownerId} />
        </div>
      )}
    </FormShell>
  );
}

// ------------------------------------------------------------ activity

export type ActivityValues = {
  type: string;
  subject: string;
  body: string;
  orgId: string;
  personId: string;
  dealId: string;
};

export function ActivityFormPage(props: {
  action: string;
  cancelHref: string;
  orgs: Org[];
  people: Person[];
  deals: Deal[];
  values: ActivityValues;
  error?: string;
}) {
  return (
    <FormShell
      title="Log activity"
      sub="Time is stamped by the server when you submit. Activities are append-only: there is no edit and no delete, by policy and by grant."
      action={props.action}
      error={props.error}
      submit="Log it"
      cancelHref={props.cancelHref}
    >
      <SelectField
        name="type"
        label="Type"
        value={props.values.type}
        required
        options={ACTIVITY_TYPES.map((t) => ({ value: t, label: ACTIVITY_LABEL[t] ?? t }))}
      />
      <Field name="subject" label="Subject" value={props.values.subject} required maxlength={200} />
      <div class="field">
        <label for="body">Notes</label>
        <textarea id="body" name="body" rows={4} maxlength={ACTIVITY_BODY_MAX}>
          {props.values.body}
        </textarea>
        <span class="hint">Optional, up to {String(ACTIVITY_BODY_MAX)} characters.</span>
      </div>
      <SelectField
        name="orgId"
        label="Organization"
        value={props.values.orgId}
        blank="—"
        options={orgOptions(props.orgs)}
      />
      <SelectField
        name="personId"
        label="Person"
        value={props.values.personId}
        blank="—"
        options={props.people.map((p) => ({ value: p.id, label: fullName(p) }))}
      />
      <SelectField
        name="dealId"
        label="Deal"
        value={props.values.dealId}
        blank="—"
        options={props.deals.map((d) => ({ value: d.id, label: d.name }))}
        hint="Link at least one of the three — an activity attached to nothing is refused."
      />
    </FormShell>
  );
}

// ------------------------------------------------------------ stage controls

/**
 * The stage control. `moves` is `allowedTransitions(deal.stage)` — the
 * domain module's list, so the select can only offer legal moves. The
 * database refuses an illegal one regardless of what this rendered, which
 * is exactly what the crafted-request test proves.
 */
export function StageControl(props: { deal: Deal; moves: DealStage[]; compact?: boolean }) {
  if (props.moves.length === 0) return null;
  return (
    <form class={props.compact ? "stage-move compact" : "stage-move"} method="post" action={`/deals/${props.deal.id}/stage`}>
      <label class="sr-only" for={`stage-${props.deal.id}`}>
        Move {props.deal.name} to
      </label>
      <select id={`stage-${props.deal.id}`} name="stage" required>
        {props.moves.map((s) => (
          <option value={s}>{STAGE_LABEL[s]}</option>
        ))}
      </select>
      <button type="submit">Move</button>
    </form>
  );
}

/** The audited exit from won/lost — manager/admin, reason required. */
export function ReopenControl(props: { deal: Deal }) {
  return (
    <form class="reopen" method="post" action={`/deals/${props.deal.id}/reopen`}>
      <div class="field">
        <label for="reason">Reason for reopening</label>
        <input id="reason" name="reason" type="text" required maxlength={200} />
        <span class="hint">
          It goes in the audit log against your name. The database refuses a blank one.
        </span>
      </div>
      <button type="submit">Reopen to Negotiation</button>
    </form>
  );
}

/** What the deal page says to someone whose role cannot make the move. */
export function StageClosed({ stage, canReopen }: { stage: DealStage; canReopen: boolean }) {
  return (
    <p class="note">
      This deal is {STAGE_LABEL[stage]} and closed. The only way out is an audited reopen back to
      Negotiation, which the database allows to managers and tenant admins only
      {canReopen ? " — yours is one of them." : ", and yours is not one of them."}
    </p>
  );
}

// ------------------------------------------------------------ audit trail

export function AuditTrail(props: { entries: AuditEntry[]; roster: Roster }) {
  if (props.entries.length === 0) return <Empty what="recorded writes yet" />;
  return (
    <div class="table-wrap">
      <table class="audit">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Record</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => {
            const href = auditHref(entry.entityType, entry.entityId);
            const target = auditTarget(entry.detail);
            return (
              <tr>
                <td class="mono nowrap">{stamp(entry.createdAt)}</td>
                <td>{memberName(props.roster, entry.actorId)}</td>
                <td>{auditLine(entry.action, entry.detail)}</td>
                <td>
                  {href ? <a href={href}>{target ?? entry.entityType}</a> : (target ?? "—")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AuditPage(props: {
  entries: AuditEntry[];
  roster: Roster;
  canRead: boolean;
  tenantName: string;
  /** the cap the query ran with — the page must not claim more than it has */
  limit: number;
}) {
  // "Every write" would be a lie on a capped query, on the one page whose
  // subject is whether this system tells the truth about itself.
  const capped = props.entries.length >= props.limit;
  return (
    <>
      <PageHead
        title="Audit trail"
        sub={
          props.canRead
            ? `${capped ? `The ${props.limit} most recent writes` : `All ${props.entries.length} writes`} ${props.tenantName} has recorded — who, what, when. The rows are written by database triggers, not by the application, and no client can insert one.`
            : undefined
        }
      />
      {props.canRead ? (
        <AuditTrail entries={props.entries} roster={props.roster} />
      ) : (
        <p class="note">
          The audit trail is shown to tenant admins only. This page asked the database for it with
          your sign-in and was given nothing — the refusal is a row-level policy, not a check in
          this page, and it would have returned the same nothing to a request that never rendered
          a page at all.
        </p>
      )}
    </>
  );
}
