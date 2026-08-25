-- CRMDEMO-EPIC1-06 — the demo-freeze switch's home.
--
-- GD-0035 ruled a demo-freeze switch: a flag the sysop flips before a live
-- walkthrough so a scheduled reset never yanks data out from under a
-- prospect. The flag must outlive a Worker isolate and survive the reset
-- itself (crm_demo_wipe does not touch this table), so it lives here.
--
-- Service plane ONLY, exactly like job_runs: RLS is enabled with NO
-- policies, so no API principal reads a row; SELECT is granted so a denied
-- read is zero rows via RLS rather than a permission error (the grant
-- matrix's posture, 20260722120004); no write grant exists below the
-- service role, so a write is refused loudly at the grant layer.
--
-- This migration re-declares no CHECK constraint; the audit_log
-- accumulated-vocab law is not in play here.

create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
-- NO policies on purpose — service plane only.

-- reads: same posture as every table (RLS yields zero rows to the API roles)
grant select on public.app_settings to anon, authenticated;

-- the service plane (new tables do not inherit the 04 matrix — grant
-- explicitly, the GENMURK-EPIC1-09 lesson)
grant all on public.app_settings to service_role;

-- the switch exists from birth, and it is born open: resets run unless the
-- sysop flips this before a walkthrough
insert into public.app_settings (key, value)
values ('demo_freeze', 'false'::jsonb);
