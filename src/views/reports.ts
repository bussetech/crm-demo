// The manager rollups (CRMDEMO-EPIC1-05) — three derivations, pure.
//
// The law this file exists to keep: EVERY NUMBER A MANAGER SEES IS A SUM
// OF ROWS THE DATABASE HANDED THIS READER. Nothing here is materialized,
// cached, estimated or carried forward; each function takes the rows a
// loader already fetched through the signed-in user's own JWT and adds
// them up. That is what makes the reconciliation spot-check
// (test/routes.test.ts) possible at all: a rendered number can be traced
// back to seed truth because there is no step in between that could have
// invented one.
//
// Three reports, and deliberately only three (track law 2 — the manager
// view is a demo beat, not a BI product):
//
//   1. pipeline — count and value per stage, and the same cut per owner
//   2. activity volume — by kind, week by week, over a fixed window
//   3. win/loss — the rate, its two counts, and the deals it came from
//
// Time is a parameter, never `new Date()` read in here: the caller passes
// `now`, so a report renders the same way in a test, on a runner and under
// a camera (the honest-capture law starts with output that does not drift).

import { ACTIVITY_TYPES, type ActivityType } from "../domain/activity";
import { DEAL_STAGES, TERMINAL_STAGES, isOpenStage, type DealStage } from "../domain/stages";
import type { ActivityPulse, Deal } from "./model";

// ------------------------------------------------------------ pipeline

export type StageRow = { stage: DealStage; count: number; value: number };

const sum = (deals: Deal[]): number => deals.reduce((total, d) => total + d.amount, 0);

/**
 * Every stage, always — including the ones with nothing in them. A stage
 * that vanishes when empty makes a shrinking pipeline look like a tidy
 * one, which is the flattering-slice failure the board already refuses.
 */
export const pipelineByStage = (deals: Deal[]): StageRow[] =>
  DEAL_STAGES.map((stage) => {
    const inStage = deals.filter((d) => d.stage === stage);
    return { stage, count: inStage.length, value: sum(inStage) };
  });

export type OwnerRow = {
  ownerId: string;
  count: number;
  value: number;
  openCount: number;
  openValue: number;
};

/**
 * The same population cut by owner, so the two tables of the pipeline
 * report add up to the same totals — a manager comparing them is checking
 * this app's arithmetic, and it has to survive that.
 *
 * Owners come from the DEALS, not from the roster: a member with no deals
 * has no row (an all-zero line for every teammate is noise), and a deal
 * whose owner has since been deactivated still appears under them rather
 * than silently leaving the total.
 */
export const pipelineByOwner = (deals: Deal[]): OwnerRow[] => {
  const owners = [...new Set(deals.map((d) => d.ownerId))];
  return owners
    .map((ownerId) => {
      const theirs = deals.filter((d) => d.ownerId === ownerId);
      const open = theirs.filter((d) => isOpenStage(d.stage));
      return {
        ownerId,
        count: theirs.length,
        value: sum(theirs),
        openCount: open.length,
        openValue: sum(open),
      };
    })
    .sort((a, b) => b.openValue - a.openValue || b.value - a.value);
};

/** Open pipeline — what a manager means by "the pipeline" when pressed. */
export const openPipeline = (deals: Deal[]): { count: number; value: number } => {
  const open = deals.filter((d) => isOpenStage(d.stage));
  return { count: open.length, value: sum(open) };
};

// ------------------------------------------------------------ activity volume

export const WEEK_MS = 7 * 86_400_000;

export type ActivityWeek = {
  /** inclusive start of the seven-day bucket, ISO */
  start: string;
  /** exclusive end, ISO */
  end: string;
  byType: Record<ActivityType, number>;
  total: number;
};

export type ActivityVolume = {
  weeks: ActivityWeek[];
  windowStart: string;
  total: number;
  byType: Record<ActivityType, number>;
  /** the busiest week's total — the y-scale, and the spike a manager is looking for */
  peak: number;
};

const emptyCounts = (): Record<ActivityType, number> =>
  Object.fromEntries(ACTIVITY_TYPES.map((t) => [t, 0])) as Record<ActivityType, number>;

/**
 * Seven-day buckets counted BACK FROM `now`, oldest first — not calendar
 * weeks. A calendar week would make the newest column a partial one whose
 * shortfall reads as a collapse in activity; every bucket here is the same
 * seven days long, so their heights are comparable by construction.
 *
 * Anything outside the window is ignored: the caller asked the database
 * for the same window, and the page names it.
 */
export const activityByWeek = (
  pulses: ActivityPulse[],
  now: Date,
  weeks: number,
): ActivityVolume => {
  const end = now.getTime();
  const buckets: ActivityWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    buckets.push({
      start: new Date(end - (i + 1) * WEEK_MS).toISOString(),
      end: new Date(end - i * WEEK_MS).toISOString(),
      byType: emptyCounts(),
      total: 0,
    });
  }

  const byType = emptyCounts();
  let total = 0;
  for (const pulse of pulses) {
    const age = end - new Date(pulse.occurredAt).getTime();
    // a row stamped a moment ago (or, on a clock skew, a moment ahead)
    // belongs to the current week rather than to nowhere
    const index = weeks - 1 - Math.floor(Math.max(age, 0) / WEEK_MS);
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.byType[pulse.type] += 1;
    bucket.total += 1;
    byType[pulse.type] += 1;
    total += 1;
  }

  return {
    weeks: buckets,
    windowStart: new Date(end - weeks * WEEK_MS).toISOString(),
    total,
    byType,
    peak: buckets.reduce((max, b) => Math.max(max, b.total), 0),
  };
};

// ------------------------------------------------------------ win / loss

export type WinLoss = {
  won: number;
  lost: number;
  wonValue: number;
  lostValue: number;
  /** won ÷ closed, or null when nothing has closed — never 0% for "no data" */
  rate: number | null;
  /** the closed deals, newest close first */
  closed: Deal[];
};

export const winLoss = (deals: Deal[]): WinLoss => {
  const closed = deals
    .filter((d) => (TERMINAL_STAGES as readonly DealStage[]).includes(d.stage))
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  const won = closed.filter((d) => d.stage === "won");
  const lost = closed.filter((d) => d.stage === "lost");
  return {
    won: won.length,
    lost: lost.length,
    wonValue: sum(won),
    lostValue: sum(lost),
    // A tenant that has closed nothing has no win rate. Rendering 0% there
    // would be a claim about performance made out of an absence of data.
    rate: closed.length === 0 ? null : won.length / closed.length,
    closed,
  };
};
