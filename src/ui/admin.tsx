// The tenant-admin surface (CRMDEMO-EPIC1-05) — the roster, and the two
// acts an admin may perform on it.
//
// The beat this page is built for is GOVERNANCE, NOT PROVISIONING: there
// is no "invite a user" here and there is not meant to be. Accounts are
// seed-provisioned (self-signup is disabled, track law 3), so what a
// tenant admin does in this demo is exactly what an enterprise admin does
// most days — change somebody's role, switch somebody off — and both of
// those are audited RPCs the database refuses to anyone else.
//
// Every control on this page is an AFFORDANCE. `membership_set_role` and
// `membership_set_active` check the caller's role themselves, refuse an
// admin acting on their own membership, and write the audit row inside the
// same transaction. Rendering or not rendering a button changes none of
// that — which is why the page can say so out loud.

import { MEMBER_ROLES, type MemberRole } from "../domain/roles";
import type { Member } from "../views/model";
import { ROLE_LABEL } from "../views/format";
import { Flash, Notice, PageHead } from "./layout";
import { RoleBadge } from "./pages";

/**
 * The roster, admin-eyes... no. Every active member reads this roster by
 * policy (reps see their teammates); what is admin-only is the ability to
 * CHANGE a row, and that lives in the database.
 */
export function AdminUsersPage(props: {
  members: Member[];
  /** the signed-in admin's own auth id — their row gets no controls */
  selfUserId: string;
  tenantName: string;
  flash?: string;
  error?: string;
}) {
  const active = props.members.filter((m) => m.active).length;
  return (
    <>
      <PageHead
        title="Users"
        sub={`${props.members.length} accounts in ${props.tenantName}, ${active} of them active. Roles and access, not provisioning — see below.`}
      />
      <Flash code={props.flash} />
      {props.error ? <Notice tone="refusal">{props.error}</Notice> : null}
      <p class="note">
        <strong>This demo does not create accounts.</strong> Every account here was provisioned
        with the scenario data, because self-signup is disabled on purpose — published demo logins
        with an open registration form would be a different, much worse posture. What a tenant
        admin governs is the accounts that exist: what role each one holds, and whether it may sign
        in at all. Both changes are recorded in the{" "}
        <a href="/audit">audit trail</a> against your name, by the database, in the same
        transaction as the change.
      </p>
      <div class="table-wrap">
        <table class="report">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
              <th>Change role</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {props.members.map((member) => (
              <tr>
                <td>
                  {member.displayName}
                  {member.userId === props.selfUserId ? <span class="hint">You</span> : null}
                </td>
                <td>
                  <RoleBadge role={member.role} active={member.active} />
                </td>
                <td class="nowrap">{member.active ? "Active" : "Deactivated"}</td>
                <td>
                  {member.userId === props.selfUserId ? (
                    <span class="muted">—</span>
                  ) : (
                    <RoleForm member={member} />
                  )}
                </td>
                <td>
                  {member.userId === props.selfUserId ? (
                    <span class="muted">—</span>
                  ) : (
                    <AccessForm member={member} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted after">
        Your own row carries no controls, and that is the database's rule rather than this page's:
        both admin functions refuse a caller acting on their own membership, so a tenant cannot be
        locked out of itself — not by a mis-click, and not by a request that never came from this
        page.
      </p>
      <p class="muted">
        A deactivated account still authenticates and still gets nowhere: it reads zero rows in
        every table, so the app declines the session at sign-in and says why. Sign in as one and
        watch it happen — the credentials are on the{" "}
        <a href="/demo">demo logins page</a>.
      </p>
    </>
  );
}

/**
 * A role select with a submit beside it — no script, so no auto-submit.
 *
 * It opens on a PLACEHOLDER rather than on a role. Rendering the first
 * available option as the default made every row's one-click action
 * "promote this person to tenant admin", because that is the first role in
 * the vocabulary — a dangerous default nobody chose, found by looking at
 * the page rather than at the code. `required` plus an empty first option
 * means a role change now takes a deliberate selection, and the router
 * refuses the empty value too, for a request that never came from here.
 */
function RoleForm({ member }: { member: Member }) {
  const others = MEMBER_ROLES.filter((role) => role !== member.role);
  return (
    <form class="inline-form" method="post" action={`/admin/users/${member.userId}/role`}>
      <label class="sr-only" for={`role-${member.userId}`}>
        New role for {member.displayName}
      </label>
      <select id={`role-${member.userId}`} name="role" required>
        <option value="">Change to…</option>
        {others.map((role: MemberRole) => (
          <option value={role}>{ROLE_LABEL[role]}</option>
        ))}
      </select>
      <button type="submit">Change</button>
    </form>
  );
}

/**
 * Deactivate and reactivate are two routes rather than one with a flag:
 * a single route taking `active=true|false` would turn a mangled value
 * into a silent deactivation, and switching someone off should never be
 * what a request means by accident.
 */
function AccessForm({ member }: { member: Member }) {
  return member.active ? (
    <form class="inline-form" method="post" action={`/admin/users/${member.userId}/deactivate`}>
      <button type="submit" class="quiet">
        Deactivate
      </button>
    </form>
  ) : (
    <form class="inline-form" method="post" action={`/admin/users/${member.userId}/activate`}>
      <button type="submit">Reactivate</button>
    </form>
  );
}
