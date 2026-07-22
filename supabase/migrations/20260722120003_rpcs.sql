-- CRMDEMO-EPIC1-02 — privileged lifecycle RPCs. SECURITY DEFINER,
-- role-checked inside, audit-writing (stratum law: privileged acts via
-- RPCs that check the role and write an audit row). Grants live in the
-- grant-matrix migration: authenticated may CALL the tenant RPCs (the
-- function refuses the wrong role loudly); crm_demo_wipe is service-plane
-- only and uncallable below the service role.

-- Shared refusal helper: loud, specific, and the same message everywhere
-- so refusals are recognizable in the proof and in demos.
create or replace function public.crm_require_role(t uuid, roles public.member_role[])
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from memberships
    where tenant_id = t and user_id = auth.uid() and active
      and role = any (roles)
  ) then
    raise exception 'requires role % in this tenant', array_to_string(roles, ' or ');
  end if;
end $$;

-- ------------------------------------------------------------ deal_reopen

-- The ONLY exit from won/lost: manager/admin, audited, back to
-- negotiation. Authorizes the stage-guard trigger through a
-- transaction-local setting scoped to exactly this deal id.
create or replace function public.deal_reopen(p_deal_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  d deals%rowtype;
begin
  select * into d from deals where id = p_deal_id;
  if not found then
    raise exception 'deal not found';
  end if;
  perform crm_require_role(d.tenant_id, array['admin', 'manager']::member_role[]);
  if d.stage not in ('won', 'lost') then
    raise exception 'only a won or lost deal can be reopened (deal is %)', d.stage;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reopen requires a reason — it goes in the audit log';
  end if;

  perform set_config('crm.reopen_deal', p_deal_id::text, true);
  update deals set stage = 'negotiation' where id = p_deal_id;
  perform set_config('crm.reopen_deal', '', true);

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (d.tenant_id, auth.uid(), 'deal.reopened', 'deal', d.id,
          jsonb_build_object('reason', trim(p_reason), 'was', d.stage,
                             'deal_name', d.name));
end $$;

-- ------------------------------------------------------------ membership admin

-- Role changes and (de)activation are tenant-admin acts. Self-service is
-- refused: an admin cannot change or deactivate their own membership —
-- the no-lockout rule, and it keeps the demo tenant administrable until
-- the next reset.

create or replace function public.membership_set_role(
  p_tenant_id uuid, p_user_id uuid, p_role public.member_role)
returns void
language plpgsql security definer set search_path = public as $$
declare
  m memberships%rowtype;
begin
  perform crm_require_role(p_tenant_id, array['admin']::member_role[]);
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role';
  end if;
  select * into m from memberships
  where tenant_id = p_tenant_id and user_id = p_user_id;
  if not found then
    raise exception 'no membership for that user in this tenant';
  end if;
  if m.role = p_role then
    raise exception 'membership already has role %', p_role;
  end if;

  update memberships set role = p_role where id = m.id;

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (p_tenant_id, auth.uid(), 'membership.role_changed', 'membership', m.id,
          jsonb_build_object('member', m.display_name,
                             'from', m.role, 'to', p_role));
end $$;

create or replace function public.membership_set_active(
  p_tenant_id uuid, p_user_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  m memberships%rowtype;
begin
  perform crm_require_role(p_tenant_id, array['admin']::member_role[]);
  if p_user_id = auth.uid() then
    raise exception 'you cannot deactivate your own membership';
  end if;
  select * into m from memberships
  where tenant_id = p_tenant_id and user_id = p_user_id;
  if not found then
    raise exception 'no membership for that user in this tenant';
  end if;
  if m.active = p_active then
    raise exception 'membership is already %',
      case when p_active then 'active' else 'deactivated' end;
  end if;

  update memberships set active = p_active where id = m.id;

  insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, detail)
  values (p_tenant_id, auth.uid(),
          case when p_active then 'membership.activated'
               else 'membership.deactivated' end,
          'membership', m.id,
          jsonb_build_object('member', m.display_name, 'role', m.role));
end $$;

-- ------------------------------------------------------------ crm_demo_wipe

-- The reset primitive: clears every tenant-scoped row (tenants themselves
-- survive — they are upserted by slug at seed time) so the seed can
-- rebuild the scenario baseline. Service plane ONLY (grant matrix); the
-- scheduled reset job (Workers cron, a later session) and scripts/seed.ts
-- are its only callers, and both journal a job_runs receipt.
create or replace function public.crm_demo_wipe()
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- explicit WHERE clauses: the API session loads pg-safeupdate, which
  -- refuses bare DELETEs even inside a SECURITY DEFINER function
  delete from activities   where id is not null;
  delete from deals        where id is not null;
  delete from people       where id is not null;
  delete from organizations where id is not null;
  delete from audit_log    where id is not null;
  delete from memberships  where id is not null;
end $$;
