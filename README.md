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
  as every role against every tenant and asserts exact row counts.
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
| `src/` | the Worker (Hono app; `/healthz` is the only route so far) |
| `supabase/` | local stack config + migrations (schema arrives by session) |
| `test/` | vitest suites; the isolation proof lands with the schema |
| `.github/workflows/` | project CI + studio app-CI shell + dispatch-only deploy |

## Build locally

```sh
npm ci
npm run typecheck && npm test
supabase start   # local stack on ports 54440–54449 (see CLAUDE.md)
```

No studio access needed. See `CLAUDE.md` for conventions and the detach
procedure.

## License

Code: MIT (`LICENSE`). All demo data is synthetic and clearly fictional.
