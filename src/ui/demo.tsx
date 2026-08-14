// The demo logins page — public, unauthenticated, and part of the product.
//
// This is the front door. A prospect meets this page before they meet the
// app, so it does three jobs and no others: hand over the credentials,
// say what each persona is for, and state the posture plainly enough that
// nobody has to guess what "demo" means here.
//
// THE HONESTY BANNER LAW APPLIES DOUBLE ON THE PUBLIC FRONT DOOR (track
// law 5). Every claim below is either a property of running software or is
// marked as not yet built — the reset posture in particular reads its
// status from src/views/demo.ts rather than describing the schedule that
// was ruled but has not shipped.

import { PERSONA, demoTenants, resetCopy } from "../views/demo";
import { ROLE_LABEL } from "../views/format";
import { MEMBER_ROLES } from "../domain/roles";
import { PageHead } from "./layout";

export function DemoLoginsPage() {
  const tenants = demoTenants();
  const accounts = tenants.reduce((total, t) => total + t.logins.length, 0);

  return (
    <div class="prose">
      <PageHead
        title="Demo logins"
        sub={`${accounts} published accounts across ${tenants.length} synthetic companies. Pick a persona, sign in, and put the app through whatever you like — none of it is real, and none of it is permanent.`}
      />

      <p class="note">
        <strong>What this is.</strong> A deliberately generic CRM —
        organizations, people, activities and deals on a pipeline — built and run by the{" "}
        <a href="https://bussetech.com">Bussetech Software Studio</a> as a live demonstration of
        how it builds multi-tenant SaaS. The CRM is the canvas; the studio is the subject. Every
        company, person, deal and note you will see was generated from a scenario script.
      </p>

      <section class="section">
        <h2>The accounts</h2>
        <p class="muted">
          Passwords are published on purpose. Self-signup is disabled and accounts are provisioned
          only by the seed, so this list is the complete set of ways into this demo — there is no
          registration form, and there is nothing here to escalate into.
        </p>
        {tenants.map((tenant) => (
          <>
            <h3 class="sub-head">{tenant.name}</h3>
            <div class="table-wrap">
              <table class="report">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Email</th>
                    <th>Password</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tenant.logins.map((login) => (
                    <tr>
                      <td class="nowrap">{login.displayName}</td>
                      <td class="nowrap">{ROLE_LABEL[login.role]}</td>
                      <td class="mono">{login.email}</td>
                      <td class="mono">{login.password}</td>
                      <td class="nowrap">
                        {login.active ? "Active" : "Deactivated — sign-in is refused"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
        <p class="after">
          <a class="button" href="/login">
            Sign in
          </a>
        </p>
      </section>

      <section class="section">
        <h2>What each persona sees</h2>
        <dl class="facts">
          {MEMBER_ROLES.map((role) => (
            <>
              <dt>{ROLE_LABEL[role]}</dt>
              <dd>{PERSONA[role]}</dd>
            </>
          ))}
        </dl>
        <p class="muted after">
          Those limits are enforced by row-level policies in the database, not by the pages. The
          app queries with your own sign-in and is handed exactly what your role may have — a
          request that skips the interface entirely meets the same refusal.
        </p>
      </section>

      <section class="section">
        <h2>Try the isolation</h2>
        <p>
          This is the part worth two minutes. Sign in as{" "}
          <strong>{tenants[0]?.name}</strong>, open any organization, and copy the id out of the
          address bar. Then sign out, sign in as <strong>{tenants[1]?.name}</strong>, and paste
          that id back in.
        </p>
        <p class="after">
          You will get a plain <em>not found</em> — not a permission error, not an empty page with
          a hint that something is there. The row is not missing; it is simply not visible to that
          sign-in, and the app is never told the difference. Search across it, filter by the other
          tenant's owner, guess at ids: the answer is the same nothing every time, because the
          boundary is in the database rather than in the code that renders these pages.
        </p>
      </section>

      <section class="section">
        <h2>The posture, stated plainly</h2>
        <dl class="facts">
          <dt>Data</dt>
          <dd>
            Entirely synthetic and clearly fictional. Every address is under the reserved{" "}
            <span class="mono">.example</span> domain, which cannot receive mail. No real person's
            information is in here, by rule and by construction — and none should be put in: treat
            everything you type as public.
          </dd>
          <dt>Resets</dt>
          <dd>{resetCopy()}</dd>
          <dt>Blast radius</dt>
          <dd>
            One synthetic tenant until the next reset. There is nothing to lose here, which is
            exactly why the credentials can be published.
          </dd>
          <dt>Availability</dt>
          <dd>
            Demo-grade, and stated as such: no uptime commitment, no durability commitment, no
            support commitment, no SLA. This is a demonstration, not a service.
          </dd>
          <dt>Security</dt>
          <dd>
            Not demo-grade, and never will be. The tenant boundary, the role model and the audit
            trail are the things being demonstrated; relaxing them for convenience would leave
            nothing worth showing.
          </dd>
        </dl>
      </section>
    </div>
  );
}
