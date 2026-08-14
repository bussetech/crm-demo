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

/** The stage-by-stage walk from `lead` up to (and including) `target`. */
export const advancePath = (target: DealStage): DealStage[] => {
  if (isTerminalStage(target)) {
    throw new Error(`advancePath is for open stages; got ${target}`);
  }
  const ladder = OPEN_STAGES as readonly DealStage[];
  return ladder.slice(0, ladder.indexOf(target) + 1);
};
