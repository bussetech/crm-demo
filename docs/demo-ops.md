# Demo operations — reset, freeze, containment (CRMDEMO-EPIC1-06)

The demo is self-healing: a scheduled job restores data **and
demo-account state** to the scenario baseline, and the containment posture
accepts what happens between resets. This file is the operator's view;
the machinery is `src/worker.ts` + `src/jobs/reset.ts` +
`src/seed/runner.ts`, and the proof is `test/reset.test.ts`.

## The reset job

- **Cadence (GD-0035, platform#429):** nightly at 04:00 ET, plus on-demand
  dispatch, plus a demo-freeze switch. The cron is declared in
  `wrangler.toml` (`0 8 * * *` UTC = 04:00 EDT; in winter it fires at
  03:00 EST — an hour early against synthetic data, stated rather than
  solved).
- **Where it runs:** the Worker's `scheduled` handler — the app plane,
  never GitHub Actions (stratum law). The job plane holds
  `SUPABASE_SERVICE_ROLE_KEY` as a Workers secret; the request path's
  binding surface (`src/env.ts`) has no such field, and
  `test/source.test.ts` keeps the two planes two.
- **What a run does:** verify the freeze is off → wipe tenant-scoped data
  (`crm_demo_wipe`) → rebuild the scenario baseline from
  `src/seed/scenario.ts` by walking the real lifecycle under the seeded
  users' own JWTs → journal a `job_runs` receipt. Accounts are matched by
  email and memberships are rebuilt from the plan, so tampered roles and
  reactivated accounts reset too.
- **Every run leaves a receipt** in `job_runs`: `job: "reset"`,
  `detail.trigger` (`cron` | `dispatch`), and on a frozen run
  `detail.skipped: "frozen"` — an honest no-op is journaled, never silent.
- **Seed-time-relative dates** mean a fresh reset always looks current;
  the reset proof asserts the newest activity is days old, not weeks.

## On-demand dispatch and the freeze switch

Three POST routes on the Worker, bearer-token authenticated
(`RESET_DISPATCH_TOKEN`, a Workers secret — the sysop provisions it at
07). Until the token exists the routes answer 404: an unprovisioned door
does not exist.

```sh
# reset now (e.g. right before a walkthrough)
curl -X POST -H "Authorization: Bearer $RESET_DISPATCH_TOKEN" \
  https://crm-demo.bussetech.com/jobs/reset

# freeze: scheduled resets skip (with a "skipped: frozen" receipt)
curl -X POST -H "Authorization: Bearer $RESET_DISPATCH_TOKEN" \
  https://crm-demo.bussetech.com/jobs/freeze

# thaw
curl -X POST -H "Authorization: Bearer $RESET_DISPATCH_TOKEN" \
  https://crm-demo.bussetech.com/jobs/unfreeze
```

The switch itself lives in `app_settings` (`demo_freeze`) — service-plane
only, like `job_runs`, and it survives both resets and Worker restarts.
Freeze flips are journaled too (`job: "freeze"` / `"unfreeze"`).

**The freeze gates dispatched resets too, on purpose:** an accidental
`POST /jobs/reset` mid-walkthrough would yank data out from under a
prospect exactly like a cron would, so a frozen dispatch is also a
skipped-with-receipt. Thaw first when a reset is really wanted — the
freeze is "do not reset", not "do not schedule".

**Freeze discipline:** flip it on before a live demo, off after. A frozen
demo skips every nightly until thawed — the receipts will show a row of
`skipped: frozen` if it is forgotten, which is the honest trail but a
stale demo.

## Containment posture (v1, track law 3)

Security NFRs are never demo-grade; these are the teeth, all shipped and
tested:

| control | where | shape |
| --- | --- | --- |
| body cap | `src/index.tsx` | POST bodies over 4 KB refused (413) before reading |
| no uploads | `src/index.tsx` | any `multipart/*` POST refused (415) — structurally, not by absence |
| rate limits | `src/limits.ts` | per-caller fixed windows: sign-in 10/min, other writes 60/min; 429 + `Retry-After` |
| CSRF | `src/auth.ts` | same-origin check on every POST + `SameSite=Lax` cookies |
| crawl policy | `/robots.txt` | app routes disallowed; `/demo` (the front door) is the one page a crawler is invited to read, and the only page without `noindex` |
| signup | `supabase/config.toml` | disabled; accounts are seed-provisioned only |

**The rate limiter is a floor, not a ceiling.** It is a fixed-window
counter in isolate memory, keyed by `CF-Connecting-IP`: best-effort by
construction (each isolate counts alone; recycled isolates forget; a
caller the edge has not named is not counted). crm-demo#14 keeps the
go-live decision open for Cloudflare's native rate-limiting binding — a
provisioning-time act with a cost fact attached, decided at 07.

## Accepted residual (stated, not hidden)

- **Defacement of a synthetic tenant between resets is self-healing by
  design.** The credentials are published on purpose; anything a visitor
  breaks, renames or fills with junk lives in one synthetic tenant and
  dies at the next reset (nightly, or on demand before a demo). The
  standing banner tells every visitor their changes are temporary and
  visible to others.
- **A determined caller can exceed the per-isolate rate floor** (many
  isolates, many IPs). What that buys against synthetic data is origin
  cost, not access — and the upgrade path is #14, not more cleverness
  here.
- **Cross-tenant access is NOT residual risk** — it is the isolation
  proof's non-waivable gate, re-proven on every push.
