# crm-demo

**Status:** ![status](https://img.shields.io/badge/status-active-00843D) ·
[![ci](https://github.com/bussetech/crm-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/bussetech/crm-demo/actions/workflows/ci.yml)
· **Site:** `https://crm-demo.bussetech.com` (goes live at the end of the
build — nothing is hosted yet) · **Visibility:** `public`

CRM Demo — a deliberately generic multi-tenant CRM (Organizations, People,
Activities, Deals on a sales pipeline) built as a **live public
demonstration** of the [Bussetech Software Studio](https://bussetech.com)'s
SaaS capability. The studio is the subject; the CRM is the canvas.

- **Multi-tenant with the isolation proof as a headline exhibit** — RLS at
  the data layer, an explicit grant matrix, and a test suite that signs in
  as every role against every tenant and asserts exact row counts:
  cross-tenant is zero rows, anonymous is nothing anywhere, a deactivated
  user is a stranger everywhere. Green in CI on every push and PR.
- **Synthetic data only**, built to four walkable demo scenarios, reset to
  baseline on a schedule. Per-role demo logins will be published on the
  site itself (signup stays disabled; accounts are seed-provisioned).
- **Everything claimed is running software** — the studio's honest-capture
  law. This README updates as reality does, not ahead of it.

## Stack

Cloudflare Workers (Hono + SSR JSX) + Supabase (Postgres/RLS/auth), per
the studio's SaaS stratum (`platform/docs/saas-stratum.md`, ADR-0048).
Build record of the deviations a public demo takes deliberately:
platform ADR-0055.

## Layout

| path | what |
| --- | --- |
| `src/` | the Worker: the app plane (`index.tsx`, every user-facing route) + the job plane (`worker.ts` + `jobs/`, the reset cron and its dispatch doors) + pure domain modules (`src/domain/`) + the scenario plan and seed engine (`src/seed/`) |
| `supabase/` | local stack config + migrations: schema with invariants → deny-by-default RLS → audited RPCs → the explicit grant matrix → the demo-freeze switch's home |
| `scripts/` | `seed.ts` (the CLI door onto the seed engine — seeds walk the real lifecycle) + stack env-bridge helpers |
| `test/` | pure domain/containment gates (no database) + the four stack proofs — **THE ISOLATION PROOF** (`isolation.test.ts`, a launch blocker), the route proof, the write proof, and the reset proof — run in CI against a real local stack |
| `docs/` | `demo-ops.md` (reset, freeze, containment posture + accepted residual) + `runbooks/provisioning.md` (the go-live checklist) |
| `.github/workflows/` | project CI (incl. the isolation-proof job and a deploy-bundle dry-run) + studio app-CI shell + dispatch-only deploy with receipts |

## Build locally

```sh
npm ci
npm run typecheck && npm test   # no database needed
supabase start                  # local stack on ports 54440–54449 (see CLAUDE.md)
npm run db:rebuild              # reset → scenario seed → the four proofs (isolation first)
```

No studio access needed. See `CLAUDE.md` for conventions and the detach
procedure.

## License

Code: MIT (`LICENSE`). All demo data is synthetic and clearly fictional.
