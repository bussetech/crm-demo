-- CRMDEMO-EPIC1-02 — row-level security. Deny by default: RLS is enabled
-- on every table and only the policies below grant anything. The
-- isolation proof (test/isolation.test.ts) is the LAUNCH BLOCKER — a
-- cross-tenant read returns ZERO ROWS, not an error; anonymous sees
-- nothing anywhere; a deactivated user is a stranger everywhere.
--
-- The role model (per tenant, via memberships):
--   admin    everything a manager can + membership administration (RPCs)
--            + the audit log
--   manager  everything a rep can + edit/transition ANY deal + reopen
--   rep      read the whole tenant; create orgs/people/activities; create
--            and work OWN deals only
--
-- Route guards in the Worker are wayfinding, not security — the database
-- governs every read because the app queries with the signed-in user's
-- JWT (stratum law).

-- Helper functions are SECURITY DEFINER so policy evaluation reads
-- memberships without recursing through RLS. Each exposes only the
-- caller's own scope; `active` is checked everywhere, which is what makes
-- deactivation total.

create or replace function public.crm_my_tenants()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from memberships
  where user_id = auth.uid() and active
$$;

create or replace function public.crm_is_member(t uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships
    where tenant_id = t and user_id = auth.uid() and active
  )
$$;

create or replace function public.crm_has_role(t uuid, roles public.member_role[])
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships
    where tenant_id = t and user_id = auth.uid() and active
      and role = any (roles)
  )
$$;

-- ------------------------------------------------------------ enable RLS

alter table public.tenants       enable row level security;
alter table public.memberships   enable row level security;
alter table public.organizations enable row level security;
alter table public.people        enable row level security;
alter table public.deals         enable row level security;
alter table public.activities    enable row level security;
alter table public.audit_log     enable row level security;
alter table public.job_runs      enable row level security;
-- job_runs: NO policies on purpose — service plane only.

-- ------------------------------------------------------------ tenants

create policy tenants_read on public.tenants
  for select using (crm_is_member(id));

-- ------------------------------------------------------------ memberships

-- The whole roster (active and deactivated) is visible to every ACTIVE
-- member of the tenant: reps see teammates, managers see the team behind
-- the rollups, admins administer it. Rows carry display_name + role only
-- — no emails, no auth data. Writes happen solely through the admin RPCs.
create policy memberships_read on public.memberships
  for select using (crm_is_member(tenant_id));

-- ------------------------------------------------------------ organizations

create policy organizations_read on public.organizations
  for select using (crm_is_member(tenant_id));

create policy organizations_insert on public.organizations
  for insert with check (
    crm_is_member(tenant_id) and created_by = auth.uid()
  );

create policy organizations_update on public.organizations
  for update using (crm_is_member(tenant_id))
  with check (crm_is_member(tenant_id));

-- ------------------------------------------------------------ people

create policy people_read on public.people
  for select using (crm_is_member(tenant_id));

create policy people_insert on public.people
  for insert with check (
    crm_is_member(tenant_id) and created_by = auth.uid()
  );

create policy people_update on public.people
  for update using (crm_is_member(tenant_id))
  with check (crm_is_member(tenant_id));

-- ------------------------------------------------------------ deals

create policy deals_read on public.deals
  for select using (crm_is_member(tenant_id));

-- A rep creates deals they own; managers/admins may create for anyone in
-- the tenant (the insert trigger separately proves the owner is an active
-- member).
create policy deals_insert on public.deals
  for insert with check (
    crm_is_member(tenant_id)
    and created_by = auth.uid()
    and (owner_id = auth.uid()
         or crm_has_role(tenant_id, array['admin', 'manager']::public.member_role[]))
  );

-- A rep works only their own deals — a foreign deal is filtered out by
-- USING, so the update affects zero rows (silent, like a read denial).
-- Managers/admins work any deal in the tenant. Reassignment to someone
-- else's book requires manager/admin (WITH CHECK).
create policy deals_update on public.deals
  for update using (
    crm_is_member(tenant_id)
    and (owner_id = auth.uid()
         or crm_has_role(tenant_id, array['admin', 'manager']::public.member_role[]))
  )
  with check (
    crm_is_member(tenant_id)
    and (owner_id = auth.uid()
         or crm_has_role(tenant_id, array['admin', 'manager']::public.member_role[]))
  );

-- ------------------------------------------------------------ activities

-- Activities are an append-only trail in v1: insert + read, no update or
-- delete policy (and no grant either — see the grant matrix).
create policy activities_read on public.activities
  for select using (crm_is_member(tenant_id));

create policy activities_insert on public.activities
  for insert with check (
    crm_is_member(tenant_id) and created_by = auth.uid()
  );

-- ------------------------------------------------------------ audit log

-- A demo surface, admin-eyes-only. Written exclusively by SECURITY
-- DEFINER paths (trigger + RPCs) — no insert policy, no insert grant.
create policy audit_read on public.audit_log
  for select using (
    crm_has_role(tenant_id, array['admin']::public.member_role[])
  );
