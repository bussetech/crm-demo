-- CRMDEMO-EPIC1-02 — the explicit minimal grant matrix (stratum law: the
-- local/default ACL gives the API roles nothing on postgres-created
-- objects, function EXECUTE included).
--
-- The grant is the outer gate; RLS is the row gate:
--   * READS  — anon + authenticated hold SELECT everywhere, so a denied
--     read returns ZERO ROWS via RLS, never a permission error.
--   * WRITES — granted ONLY where a write policy exists (orgs, people,
--     activities-insert, deals). A write outside that surface (audit_log,
--     memberships, tenants, job_runs, any DELETE) is refused at the grant
--     layer: permission denied — loud.
--   * The service role is confined to the server plane and holds
--     everything (it is the seed/reset/ingestion identity).

-- reads: RLS decides which rows; anon's policies yield none
grant select on all tables in schema public to anon, authenticated;

-- writes: exactly the write-policy surface, nothing else
grant insert, update on public.organizations to authenticated;
grant insert, update on public.people        to authenticated;
grant insert, update on public.deals         to authenticated;
grant insert         on public.activities    to authenticated;

-- the service plane
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- functions: strip default EXECUTE, then grant deliberately
revoke execute on all functions in schema public from public, anon, authenticated;

-- policy/trigger helpers evaluate inside RLS for whoever queries — anon
-- included (they resolve to "no scope" for anon and yield zero rows)
grant execute on function public.crm_my_tenants()                                    to anon, authenticated, service_role;
grant execute on function public.crm_is_member(uuid)                                 to anon, authenticated, service_role;
grant execute on function public.crm_has_role(uuid, public.member_role[])            to anon, authenticated, service_role;
grant execute on function public.crm_user_is_active_member(uuid, uuid)               to anon, authenticated, service_role;
grant execute on function public.crm_deal_transition_allowed(public.deal_stage, public.deal_stage, boolean)
                                                                                      to anon, authenticated, service_role;

-- lifecycle RPCs: signed-in users may CALL them; each checks the role and
-- refuses everyone else loudly. anon cannot even call.
grant execute on function public.crm_require_role(uuid, public.member_role[])        to authenticated, service_role;
grant execute on function public.deal_reopen(uuid, text)                             to authenticated, service_role;
grant execute on function public.membership_set_role(uuid, uuid, public.member_role) to authenticated, service_role;
grant execute on function public.membership_set_active(uuid, uuid, boolean)          to authenticated, service_role;

-- the reset primitive: service plane ONLY (asserted by the isolation
-- proof — an authenticated call must be a permission error)
grant execute on function public.crm_demo_wipe() to service_role;
