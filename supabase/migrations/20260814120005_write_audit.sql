-- CRMDEMO-EPIC1-04 — what the WRITE surfaces need from the database.
--
-- 02 built the write surface itself (RLS policies + the grant matrix) and
-- audited the two PRIVILEGED acts: stage transitions and the membership
-- RPCs. 04 makes the day-in-the-life walkable in the UI, and the demo beat
-- it has to carry is "the audit trail shows every step" — so ordinary
-- record writes become audited too. Nothing here widens who may write:
-- every policy and every grant is exactly as 02 left it.
--
-- Three things land:
--   1. the audit vocabulary grows (creates/edits of the four entities);
--   2. audit triggers write those rows — SECURITY DEFINER, because
--      audit_log has no insert policy and no insert grant for anyone, and
--      that stays true (the audit trail is written BY the database, never
--      BY a client);
--   3. two honesty fixes writes expose: updated_at actually moves on an
--      UPDATE, and a note body has a length the database enforces.
--
-- ACCUMULATED-VOCAB LAW (GENMURK-EPIC1-10): the action CHECK below
-- restates the FULL vocabulary accumulated to date. It is not a diff.

-- ------------------------------------------------------------ vocabulary

alter table public.audit_log drop constraint audit_log_action_check;

alter table public.audit_log add constraint audit_log_action_check check (action in (
  -- 02's vocabulary, restated in full
  'deal.stage_changed',
  'deal.reopened',
  'membership.role_changed',
  'membership.deactivated',
  'membership.activated',
  'demo.reset',
  -- 04 adds the ordinary record writes
  'organization.created',
  'organization.updated',
  'person.created',
  'person.updated',
  'deal.created',
  'deal.updated',
  'activity.logged'
));

-- ------------------------------------------------------------ updated_at

-- organizations and people carried an updated_at that nothing ever moved:
-- harmless while the app was read-only, a lie the moment an edit form
-- exists. (deals already maintain theirs inside crm_deal_update_guard.)
create or replace function public.crm_touch_updated_at()
returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger org_touch_updated_at
  before update on public.organizations
  for each row execute function public.crm_touch_updated_at();

create trigger person_touch_updated_at
  before update on public.people
  for each row execute function public.crm_touch_updated_at();

-- ------------------------------------------------------------ body length

-- The Worker caps a request body at 4 KB (track law 3) and the note form
-- caps its textarea; this is the backstop that makes both true statements
-- about the data rather than about the client.
alter table public.activities
  add constraint activities_body_length
  check (body is null or length(body) <= 2000);

-- ------------------------------------------------------------ audit: organizations

create or replace function public.crm_audit_org_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'organization.created', 'organization', new.id,
          jsonb_build_object('name', new.name));
  return null;
end $$;

create trigger org_audit_insert
  after insert on public.organizations
  for each row execute function public.crm_audit_org_insert();

create or replace function public.crm_audit_org_update()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed text[] := '{}';
begin
  if new.name     is distinct from old.name     then changed := changed || 'name'::text;     end if;
  if new.domain   is distinct from old.domain   then changed := changed || 'domain'::text;   end if;
  if new.industry is distinct from old.industry then changed := changed || 'industry'::text; end if;
  if new.city     is distinct from old.city     then changed := changed || 'city'::text;     end if;
  -- an UPDATE that changed nothing a reader can see is not an audit event
  if cardinality(changed) = 0 then return null; end if;

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'organization.updated', 'organization', new.id,
          jsonb_build_object('name', new.name, 'changed', to_jsonb(changed)));
  return null;
end $$;

create trigger org_audit_update
  after update on public.organizations
  for each row execute function public.crm_audit_org_update();

-- ------------------------------------------------------------ audit: people

create or replace function public.crm_audit_person_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'person.created', 'person', new.id,
          jsonb_build_object('name', new.first_name || ' ' || new.last_name));
  return null;
end $$;

create trigger person_audit_insert
  after insert on public.people
  for each row execute function public.crm_audit_person_insert();

create or replace function public.crm_audit_person_update()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed text[] := '{}';
begin
  if new.first_name is distinct from old.first_name then changed := changed || 'first name'::text; end if;
  if new.last_name  is distinct from old.last_name  then changed := changed || 'last name'::text;  end if;
  if new.email      is distinct from old.email      then changed := changed || 'email'::text;      end if;
  if new.title      is distinct from old.title      then changed := changed || 'title'::text;      end if;
  if new.phone      is distinct from old.phone      then changed := changed || 'phone'::text;      end if;
  if new.org_id     is distinct from old.org_id     then changed := changed || 'organization'::text; end if;
  if cardinality(changed) = 0 then return null; end if;

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'person.updated', 'person', new.id,
          jsonb_build_object('name', new.first_name || ' ' || new.last_name,
                             'changed', to_jsonb(changed)));
  return null;
end $$;

create trigger person_audit_update
  after update on public.people
  for each row execute function public.crm_audit_person_update();

-- ------------------------------------------------------------ audit: deals

create or replace function public.crm_audit_deal_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'deal.created', 'deal', new.id,
          jsonb_build_object('deal_name', new.name, 'amount', new.amount,
                             'stage', new.stage));
  return null;
end $$;

create trigger deal_audit_insert
  after insert on public.deals
  for each row execute function public.crm_audit_deal_insert();

-- Stage moves are audited by crm_deal_update_guard (02) — this covers the
-- fields an edit form touches, and deliberately says nothing about stage
-- so a single UPDATE never produces two rows for the same change.
create or replace function public.crm_audit_deal_update()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed text[] := '{}';
begin
  if new.name     is distinct from old.name     then changed := changed || 'name'::text;   end if;
  if new.amount   is distinct from old.amount   then changed := changed || 'amount'::text; end if;
  if new.owner_id is distinct from old.owner_id then changed := changed || 'owner'::text;  end if;
  if cardinality(changed) = 0 then return null; end if;

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'deal.updated', 'deal', new.id,
          jsonb_build_object('deal_name', new.name, 'changed', to_jsonb(changed),
                             'amount', new.amount));
  return null;
end $$;

create trigger deal_audit_update
  after update on public.deals
  for each row execute function public.crm_audit_deal_update();

-- ------------------------------------------------------------ audit: activities

-- Activities are append-only (no update policy, no update grant), so
-- logging one is the only event there is.
create or replace function public.crm_audit_activity_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (new.tenant_id, auth.uid(), 'activity.logged', 'activity', new.id,
          jsonb_build_object('type', new.type, 'subject', new.subject));
  return null;
end $$;

create trigger activity_audit_insert
  after insert on public.activities
  for each row execute function public.crm_audit_activity_insert();

-- ------------------------------------------------------------ grants

-- Migration 4 stripped the default EXECUTE from every function that
-- existed then; these were created after it, so they carry PUBLIC's
-- default and have to be stripped in turn. Trigger functions do not need
-- an EXECUTE grant to fire (the trigger mechanism calls them), which is
-- why 02's guards work with none — and a SECURITY DEFINER function that
-- writes audit rows is exactly the thing no client should be able to call
-- by name.
revoke execute on function public.crm_touch_updated_at()       from public, anon, authenticated;
revoke execute on function public.crm_audit_org_insert()       from public, anon, authenticated;
revoke execute on function public.crm_audit_org_update()       from public, anon, authenticated;
revoke execute on function public.crm_audit_person_insert()    from public, anon, authenticated;
revoke execute on function public.crm_audit_person_update()    from public, anon, authenticated;
revoke execute on function public.crm_audit_deal_insert()      from public, anon, authenticated;
revoke execute on function public.crm_audit_deal_update()      from public, anon, authenticated;
revoke execute on function public.crm_audit_activity_insert()  from public, anon, authenticated;
