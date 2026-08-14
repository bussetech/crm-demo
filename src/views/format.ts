// Presentation helpers. Deliberately dependency-free and locale-fixed
// (en-US, UTC) so a rendered page is the same string on a laptop, on a
// runner, and in a capture — the honest-capture law starts with output
// that does not drift under the camera.

import type { DealStage } from "../domain/stages";

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

/** A short, honest description of an audit row for the stage-history list. */
export function auditLine(action: string, detail: Record<string, unknown>): string {
  const from = typeof detail["from"] === "string" ? (detail["from"] as DealStage) : null;
  const to = typeof detail["to"] === "string" ? (detail["to"] as DealStage) : null;
  const reason = typeof detail["reason"] === "string" ? (detail["reason"] as string) : null;
  switch (action) {
    case "deal.stage_changed":
      return from && to ? `${STAGE_LABEL[from]} → ${STAGE_LABEL[to]}` : "Stage changed";
    case "deal.reopened":
      return reason ? `Reopened — ${reason}` : "Reopened";
    default:
      return action;
  }
}
