// Input validation — the pure-TS twin of the schema CHECK constraints
// (migration 20260722120001). The database is the enforcement of record;
// this module lets forms refuse bad input before a round-trip and makes
// the rules unit-testable without a stack.

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const ok: ValidationResult = { ok: true };
const fail = (reason: string): ValidationResult => ({ ok: false, reason });

const trimmedLengthBetween = (value: string, min: number, max: number): boolean => {
  const length = value.trim().length;
  return length >= min && length <= max;
};

export const validateTenantName = (name: string): ValidationResult =>
  trimmedLengthBetween(name, 1, 120) ? ok : fail("tenant name must be 1–120 characters");

export const validateOrganizationName = (name: string): ValidationResult =>
  trimmedLengthBetween(name, 1, 120)
    ? ok
    : fail("organization name must be 1–120 characters");

export const validatePersonName = (name: string): ValidationResult =>
  trimmedLengthBetween(name, 1, 60) ? ok : fail("name must be 1–60 characters");

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const validateEmail = (email: string | null): ValidationResult => {
  if (email === null || email === "") return ok; // optional
  return EMAIL_SHAPE.test(email) ? ok : fail("email must look like name@host.tld");
};

export const validateDealName = (name: string): ValidationResult =>
  trimmedLengthBetween(name, 1, 160) ? ok : fail("deal name must be 1–160 characters");

export const validateDealAmount = (amount: number): ValidationResult => {
  if (!Number.isFinite(amount)) return fail("amount must be a number");
  if (amount < 0) return fail("amount must be zero or positive");
  return ok;
};

export const validateActivitySubject = (subject: string): ValidationResult =>
  trimmedLengthBetween(subject, 1, 200) ? ok : fail("subject must be 1–200 characters");

export type ActivityLinks = {
  orgId?: string | null;
  personId?: string | null;
  dealId?: string | null;
};

/** An activity must link to at least one of org / person / deal. */
export const validateActivityLinks = (links: ActivityLinks): ValidationResult =>
  links.orgId || links.personId || links.dealId
    ? ok
    : fail("an activity must link to an organization, a person, or a deal");

export const validateReopenReason = (reason: string): ValidationResult =>
  reason.trim().length > 0 ? ok : fail("a reopen requires a reason for the audit log");
