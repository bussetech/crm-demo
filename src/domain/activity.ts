// Activity kinds — the pure-TS twin of the public.activity_type enum
// (supabase/migrations/20260722120001_schema.sql). Small, but it earns its
// own module for the same reason stages and roles have theirs: the list
// was being retyped as a literal in the router, in the pages and in the
// formatter, and a vocabulary that lives in four places drifts in one.
// Keep this and the SQL enum in lockstep.

export const ACTIVITY_TYPES = ["call", "email", "meeting", "note"] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const isActivityType = (value: string): value is ActivityType =>
  (ACTIVITY_TYPES as readonly string[]).includes(value);
