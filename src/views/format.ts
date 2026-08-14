// Presentation helpers. Deliberately dependency-free and locale-fixed
// (en-US, UTC) so a rendered page is the same string on a laptop, on a
// runner, and in a capture — the honest-capture law starts with output
// that does not drift under the camera.

import type { DealStage } from "../domain/stages";
import type { MemberRole } from "../domain/roles";

export const ROLE_LABEL: Record<MemberRole, string> = {
  admin: "Tenant admin",
  manager: "Manager",
  rep: "Rep",
};

export const STAGE_LABEL: Record<DealStage, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export const ACTIVITY_LABEL: Record<string, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
};

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export const money = (amount: number): string => MONEY.format(amount);

const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const DATETIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export const day = (iso: string): string => DATE.format(new Date(iso));
export const stamp = (iso: string): string => `${DATETIME.format(new Date(iso))} UTC`;

/** "today" / "3 days ago" / "2 months ago" — relative to a supplied now. */
export function since(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days < 0) return "upcoming";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

export const fullName = (p: { firstName: string; lastName: string }): string =>
  `${p.firstName} ${p.lastName}`;

const text = (detail: Record<string, unknown>, key: string): string | null =>
  typeof detail[key] === "string" ? (detail[key] as string) : null;

/** `detail.changed` is a jsonb array of field names the trigger recorded. */
const changedFields = (detail: Record<string, unknown>): string | null => {
  const raw = detail["changed"];
  if (!Array.isArray(raw)) return null;
  const fields = raw.filter((f): f is string => typeof f === "string");
  return fields.length > 0 ? fields.join(", ") : null;
};

/**
 * A short, honest description of an audit row — used both by a deal's own
 * history and by the tenant audit trail. It says WHAT happened; the name
 * of the thing it happened to is `auditTarget`, so a deal page does not
 * repeat the deal's name on every line.
 *
 * An action this build does not know still renders — as itself. A trail
 * that silently drops rows it cannot phrase is worse than a plain one.
 */
export function auditLine(action: string, detail: Record<string, unknown>): string {
  const from = text(detail, "from");
  const to = text(detail, "to");
  const reason = text(detail, "reason");
  const changed = changedFields(detail);
  const stage = text(detail, "stage") as DealStage | null;
  const type = text(detail, "type");

  switch (action) {
    case "deal.stage_changed":
      return from && to
        ? `${STAGE_LABEL[from as DealStage]} → ${STAGE_LABEL[to as DealStage]}`
        : "Stage changed";
    case "deal.reopened":
      return reason ? `Reopened — ${reason}` : "Reopened";
    case "deal.created":
      return stage ? `Deal created at ${STAGE_LABEL[stage]}` : "Deal created";
    case "deal.updated":
      return changed ? `Deal edited — ${changed}` : "Deal edited";
    case "organization.created":
      return "Organization added";
    case "organization.updated":
      return changed ? `Organization edited — ${changed}` : "Organization edited";
    case "person.created":
      return "Person added";
    case "person.updated":
      return changed ? `Person edited — ${changed}` : "Person edited";
    case "activity.logged":
      return type ? `${ACTIVITY_LABEL[type] ?? type} logged` : "Activity logged";
    case "membership.role_changed":
      return from && to
        ? `Role changed — ${ROLE_LABEL[from as MemberRole]} → ${ROLE_LABEL[to as MemberRole]}`
        : "Role changed";
    case "membership.deactivated":
      return "Member deactivated";
    case "membership.activated":
      return "Member reactivated";
    case "demo.reset":
      return "Demo data reset to the scenario baseline";
    default:
      return action;
  }
}

/**
 * The human name of the record an audit row is about. The triggers write
 * it into the row on purpose: an audit trail has to stay readable after
 * the record it describes is gone, which a join could not promise.
 */
export function auditTarget(detail: Record<string, unknown>): string | null {
  return (
    text(detail, "deal_name") ??
    text(detail, "name") ??
    text(detail, "subject") ??
    text(detail, "member")
  );
}

/** Where an audit row points, when it points anywhere a reader can open. */
export function auditHref(entityType: string, entityId: string | null): string | null {
  if (!entityId) return null;
  switch (entityType) {
    case "deal":
      return `/deals/${entityId}`;
    case "organization":
      return `/organizations/${entityId}`;
    case "person":
      return `/people/${entityId}`;
    // activities and memberships have no page of their own in v1
    default:
      return null;
  }
}
