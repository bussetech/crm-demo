// Pipeline stage rules — the pure-TS twin of crm_deal_transition_allowed
// (supabase/migrations/20260722120001_schema.sql). The database binds
// every write path; this module makes the same rules runnable without a
// database. Keep the two in lockstep: any rule change edits both.

export const DEAL_STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const OPEN_STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
] as const satisfies readonly DealStage[];

export const TERMINAL_STAGES = ["won", "lost"] as const satisfies readonly DealStage[];

export const INITIAL_STAGE: DealStage = "lead";

export const isOpenStage = (stage: DealStage): boolean =>
  (OPEN_STAGES as readonly DealStage[]).includes(stage);

export const isTerminalStage = (stage: DealStage): boolean =>
  (TERMINAL_STAGES as readonly DealStage[]).includes(stage);

/**
 * Whether a stage transition is legal.
 *
 * - open stages move freely among themselves (forward or back —
 *   re-qualifying is normal CRM life);
 * - `won` is reachable only from `negotiation`;
 * - `lost` is reachable from any open stage;
 * - `won`/`lost` are terminal: the only exit is an audited reopen, which
 *   returns the deal to `negotiation`.
 */
export const isTransitionAllowed = (
  from: DealStage,
  to: DealStage,
  options: { reopen?: boolean } = {},
): boolean => {
  if (from === to) return false;
  if (isTerminalStage(from)) return options.reopen === true && to === "negotiation";
  if (to === "won") return from === "negotiation";
  if (to === "lost") return true;
  return true; // open → open, either direction
};

/**
 * The moves a deal at `from` may legally make — the same rule as
 * `isTransitionAllowed`, asked the other way round so a UI can offer
 * exactly the legal set instead of guessing at one.
 *
 * This is what drives the stage control (CRMDEMO-EPIC1-04). It is an
 * AFFORDANCE, not an authorization: the database refuses an illegal move
 * whether or not this list was ever consulted, which is what makes a
 * crafted request land on the same refusal as a mis-rendered form.
 *
 * A won/lost deal has no ordinary moves at all — its only exit is the
 * audited `deal_reopen` RPC, so this returns an empty list for it and the
 * page offers the reopen path instead.
 */
export const allowedTransitions = (
  from: DealStage,
  options: { reopen?: boolean } = {},
): DealStage[] => DEAL_STAGES.filter((to) => isTransitionAllowed(from, to, options));

/** The stage-by-stage walk from `lead` up to (and including) `target`. */
export const advancePath = (target: DealStage): DealStage[] => {
  if (isTerminalStage(target)) {
    throw new Error(`advancePath is for open stages; got ${target}`);
  }
  const ladder = OPEN_STAGES as readonly DealStage[];
  return ladder.slice(0, ladder.indexOf(target) + 1);
};
