-- CRMDEMO-EPIC1-02 — schema with teeth (stratum order: schema → RLS →
-- RPCs → grants). Business invariants live HERE (CHECKs + triggers) and
-- in the pure-TS domain modules (src/domain/*) — the database binds every
-- write path including the service role; the TS twin runs without a
-- database. Keep the two in lockstep: any rule change edits both.

-- ------------------------------------------------------------ enums

create type public.member_role as enum ('admin', 'manager', 'rep');

create type public.deal_stage as enum
  ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost');

create type public.activity_type as enum ('call', 'email', 'meeting', 'note');

-- ------------------------------------------------------------ tenants

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name       text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ memberships

-- user ↔ tenant ↔ role. Accounts are seed-provisioned Supabase auth users
-- (signup disabled); a membership with active = false is a deactivated
-- user: they can still authenticate, but every policy treats them as a
-- stranger (zero rows, zero writes).
create table public.memberships (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.member_role not null,
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- ------------------------------------------------------------ organizations

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 120),
  domain     text check (domain is null or domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  industry   text,
  city       text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- composite target so child rows can prove same-tenant linkage by FK
  unique (tenant_id, id)
);

-- ------------------------------------------------------------ people

create table public.people (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  org_id     uuid not null,
  first_name text not null check (length(trim(first_name)) between 1 and 60),
  last_name  text not null check (length(trim(last_name)) between 1 and 60),
  email      text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  title      text,
  phone      text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  -- a person's organization is in the same tenant, structurally
  foreign key (tenant_id, org_id)
    references public.organizations (tenant_id, id) on delete cascade
);

-- ------------------------------------------------------------ deals

-- Deals are born at 'lead' (insert trigger below) and move only through
-- legal transitions (update trigger) — seeds and app alike must walk the
-- real lifecycle. closed_at is trigger-maintained and CHECK-bound to the
-- terminal stages.
create table public.deals (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  org_id     uuid not null,
  owner_id   uuid not null references auth.users (id),
  name       text not null check (length(trim(name)) between 1 and 160),
  amount     numeric(12, 2) not null check (amount >= 0),
  stage      public.deal_stage not null default 'lead',
  closed_at  timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, org_id)
    references public.organizations (tenant_id, id) on delete cascade,
  check ((stage in ('won', 'lost')) = (closed_at is not null))
);

-- ------------------------------------------------------------ activities

-- call / email / meeting / note, polymorphically linked to an org, a
-- person and/or a deal — at least one link, every link same-tenant by
-- composite FK.
create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  type        public.activity_type not null,
  subject     text not null check (length(trim(subject)) between 1 and 200),
  body        text,
  occurred_at timestamptz not null,
  org_id      uuid,
  person_id   uuid,
  deal_id     uuid,
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, org_id)
    references public.organizations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, person_id)
    references public.people (tenant_id, id) on delete cascade,
  foreign key (tenant_id, deal_id)
    references public.deals (tenant_id, id) on delete cascade,
  check (org_id is not null or person_id is not null or deal_id is not null)
);

-- ------------------------------------------------------------ audit log

-- Per-tenant audit trail, written by the stage-transition trigger and the
-- privileged RPCs. It is a demo surface (admin-readable) — keep rows
-- human-readable. ACCUMULATED-VOCAB LAW (GENMURK-EPIC1-10): any migration
-- that re-declares audit_log_action_check must restate the FULL vocabulary
-- accumulated to date, never copy an older migration's list.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  actor_id    uuid,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint audit_log_action_check check (action in (
    'deal.stage_changed',
    'deal.reopened',
    'membership.role_changed',
    'membership.deactivated',
    'membership.activated',
    'demo.reset'
  ))
);

create index audit_log_tenant_created_idx
  on public.audit_log (tenant_id, created_at desc);

-- ------------------------------------------------------------ job runs

-- Observability journal for scheduled/CLI jobs (stratum law: an empty
-- queue is an honest no-op with a receipt, not silence). Service plane
-- only — RLS is enabled with NO policies, so no API principal reads it.
create table public.job_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb not null default '{}'::jsonb
);

-- ------------------------------------------------------------ helpers used by triggers

-- Membership lookup that must not recurse through RLS: SECURITY DEFINER,
-- exposes only a boolean about a (tenant, user) pair.
create or replace function public.crm_user_is_active_member(t uuid, u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships
    where tenant_id = t and user_id = u and active
  )
$$;

-- ------------------------------------------------------------ domain: stage transitions

-- The single SQL source of transition legality; the TS twin is
-- src/domain/stages.ts. Rules:
--   * open stages (lead/qualified/proposal/negotiation) move freely among
--     themselves (forward or back — re-qualifying is normal CRM life);
--   * won is reachable only from negotiation;
--   * lost is reachable from any open stage;
--   * won/lost are terminal: the ONLY exit is an audited reopen (the
--     deal_reopen RPC), which returns the deal to negotiation.
create or replace function public.crm_deal_transition_allowed(
  from_stage public.deal_stage,
  to_stage   public.deal_stage,
  reopen     boolean
) returns boolean
language sql immutable as $$
  select case
    when from_stage = to_stage then false
    when from_stage in ('won', 'lost')
      then reopen and to_stage = 'negotiation'
    when to_stage = 'won'  then from_stage = 'negotiation'
    when to_stage = 'lost' then true
    else true  -- open → open, either direction
  end
$$;

-- Deals are born at lead, open, unclosed — the lifecycle is walked, never
-- shortcut (a seed that violates this is the trigger working).
create or replace function public.crm_deal_insert_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage <> 'lead' then
    raise exception 'deals are born at stage lead, not %', new.stage;
  end if;
  if new.closed_at is not null then
    raise exception 'a new deal cannot carry closed_at';
  end if;
  if not crm_user_is_active_member(new.tenant_id, new.owner_id) then
    raise exception 'deal owner must be an active member of the tenant';
  end if;
  return new;
end $$;

create trigger deal_insert_guard
  before insert on public.deals
  for each row execute function public.crm_deal_insert_guard();

-- Stage transitions: legality-checked, closed_at-maintained, audited.
-- The reopen gate is a transaction-local setting written only by the
-- deal_reopen RPC (SECURITY DEFINER, role-checked) — a raw UPDATE out of
-- won/lost can never satisfy it.
create or replace function public.crm_deal_update_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  reopen_ok boolean;
begin
  if new.tenant_id <> old.tenant_id then
    raise exception 'tenant_id is immutable';
  end if;
  if new.org_id <> old.org_id then
    raise exception 'org_id is immutable — recreate the deal instead';
  end if;
  if new.owner_id <> old.owner_id
     and not crm_user_is_active_member(new.tenant_id, new.owner_id) then
    raise exception 'deal owner must be an active member of the tenant';
  end if;

  if new.stage = old.stage then
    if new.closed_at is distinct from old.closed_at then
      raise exception 'closed_at is trigger-maintained';
    end if;
    new.updated_at := now();
    return new;
  end if;

  reopen_ok := coalesce(current_setting('crm.reopen_deal', true), '')
               = old.id::text;
  if not crm_deal_transition_allowed(old.stage, new.stage, reopen_ok) then
    raise exception 'illegal stage transition % -> %', old.stage, new.stage;
  end if;

  if new.stage in ('won', 'lost') then
    new.closed_at := now();
  else
    new.closed_at := null;
  end if;
  new.updated_at := now();

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (old.tenant_id, auth.uid(), 'deal.stage_changed', 'deal', old.id,
          jsonb_build_object('from', old.stage, 'to', new.stage,
                             'reopen', reopen_ok, 'deal_name', old.name));
  return new;
end $$;

create trigger deal_update_guard
  before update on public.deals
  for each row execute function public.crm_deal_update_guard();

-- ------------------------------------------------------------ tenant immutability

-- The one column no UPDATE may ever move on any tenant-scoped table.
create or replace function public.crm_tenant_immutable()
returns trigger
language plpgsql as $$
begin
  if new.tenant_id <> old.tenant_id then
    raise exception 'tenant_id is immutable';
  end if;
  return new;
end $$;

create trigger org_tenant_immutable
  before update on public.organizations
  for each row execute function public.crm_tenant_immutable();

create trigger person_tenant_immutable
  before update on public.people
  for each row execute function public.crm_tenant_immutable();

-- (deals enforce this inside crm_deal_update_guard; activities and
-- memberships have no API-facing update path at all.)
