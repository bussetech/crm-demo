// Role capabilities — the pure-TS twin of the RLS policies + RPC role
// checks (migrations 20260722120002/-03). Route guards and UI affordances
// consult THIS module; the database independently enforces the same rules
// on every query. Keep the two in lockstep.

export const MEMBER_ROLES = ["admin", "manager", "rep"] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

export type Membership = {
  role: MemberRole;
  active: boolean;
};

/** A deactivated member is a stranger everywhere — the base gate. */
export const canReadTenantData = (m: Membership): boolean => m.active;

/** Orgs, people, activities: every active member creates and edits. */
export const canCreateRecords = (m: Membership): boolean => m.active;

/** Reps create deals they own; managers/admins may create for anyone. */
export const canCreateDeal = (m: Membership, ownerIsSelf: boolean): boolean =>
  m.active && (ownerIsSelf || m.role === "admin" || m.role === "manager");

/** Reps work only their own deals; managers/admins work any. */
export const canUpdateDeal = (m: Membership, isOwner: boolean): boolean =>
  m.active && (isOwner || m.role === "admin" || m.role === "manager");

/** The only exit from won/lost — manager/admin, always audited. */
export const canReopenDeal = (m: Membership): boolean =>
  m.active && (m.role === "admin" || m.role === "manager");

/** Membership administration (role changes, deactivation) — admin only. */
export const canManageMemberships = (m: Membership): boolean =>
  m.active && m.role === "admin";

/** The audit log is a demo surface, admin-eyes-only. */
export const canReadAuditLog = (m: Membership): boolean =>
  m.active && m.role === "admin";
