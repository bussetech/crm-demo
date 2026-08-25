# Go-live provisioning — the CRMDEMO-EPIC1-07 checklist

Everything below is a **sysop act**. The build (01–06) is complete and
proven against the local stack with zero PROD contact; this runbook is
what 07 fills in, in order. Nothing here is optional; nothing here is
already done.

## 1. Hosted Supabase project

1. Create the hosted project (org account, provider store for its
   secrets — never this repo, never chat).
2. Apply migrations: `supabase db push` (or `supabase migration up`)
   against the hosted project — all six, including
   `20260825120006_app_settings.sql` (the freeze switch's home).
3. **Disable signup** in the hosted Auth settings to match
   `supabase/config.toml` (local config does not travel).
4. Seed the scenario baseline once from a console:
   `SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/seed.ts`
5. Run the proofs against the hosted stack the same way
   (`scripts/run-isolation.sh` honors pre-set `SUPABASE_*`): the isolation
   proof green against PROD is the go/no-go gate (track law 1).

## 2. Cloudflare Worker

1. Workers **paid plan** consideration, stated with its cost fact: the
   reset job makes several hundred upstream calls per run (auth sign-ins +
   row inserts for three tenants) — the free plan's 50-subrequest cap
   cannot run it; the paid plan's 1000 can (measured locally: the full
   rebuild is ~3.5 s of wall time and comfortably under the cap). The
   cron trigger itself also requires the Worker to be deployed with
   `[triggers]` intact.
2. `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` — the job plane's
   credential. The request path cannot read it by construction
   (`src/env.ts` has no such field; `test/source.test.ts` gates it).
3. `wrangler secret put RESET_DISPATCH_TOKEN` — mint a long random token
   (e.g. `openssl rand -hex 32`), store it in the provider store. This is
   what turns the `/jobs/*` dispatch routes on (they answer 404 until it
   exists).
4. Set the real vars for PROD (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) —
   `wrangler.toml` ships them empty on purpose.
5. GitHub Actions repo secrets for `deploy.yml`:
   `CLOUDFLARE_API_TOKEN_CRM_DEMO` (repo-scoped deploy credential — the
   ONE GitHub-side exception, ADR-0023 §3) and
   `CLOUDFLARE_ACCOUNT_ID_CRM_DEMO`.
6. First deploy: dispatch `deploy.yml` with confirm=`deploy`. The full
   gate (typecheck → unit → isolation/route/write/reset proofs from a
   clean runner stack) runs before `wrangler deploy`; the receipt lands on
   the `deploys` branch; `/healthz` must answer with the same build id.
7. Wire the custom domain `crm-demo.bussetech.com` to the Worker
   (**Workers route, never GitHub Pages** — ADR-0055 §2; do not run
   pages-wire).

## 3. Verify the demo ops end to end (against PROD, once live)

1. `POST /jobs/reset` with the token → 200, receipt in `job_runs`, the
   site walks fresh.
2. The freeze drill (compressed): `POST /jobs/freeze` → `POST
   /jobs/reset` → the response and the receipt both say
   `skipped: frozen` (the freeze gates DISPATCHED resets too — an
   accidental reset mid-walkthrough is exactly as harmful as a scheduled
   one; thaw first when a reset is really wanted) → `POST /jobs/unfreeze`
   → `POST /jobs/reset` → a real run with a receipt. Leave it thawed.
3. Confirm `/robots.txt`, `/demo` (indexable, credentials work), a
   published login signs in, a deactivated one is refused.

## 4. Studio control plane (cross-plane, bounded list)

1. platform registry: flip crm-demo `status: planned → active` (one
   edit; the steward and portal follow from it) + DNS per the registry
   flow.
2. platform `uat/sites/crm-demo.yml`: fill `base_url:
   "https://crm-demo.bussetech.com"` and extend the probes per the 06
   handoff (healthz status + build id, `/demo` 200, `/login` 200).
3. Heartbeat/beacon entries per the founding registry block.

## 5. After go-live

- Rule crm-demo#14 (rate-limit binding — recommendation: Cloudflare's
  native rate-limiting binding on `POST /login` and the write routes;
  default if unruled: ship it at go-live rather than delaying go-live).
- Close the go-live checklist crm-demo#1.
- The showcase claim flips per ADR-0052 (honest capture) only once all of
  the above is true.
