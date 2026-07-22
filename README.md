# crm-demo

**Status:** ![status](https://img.shields.io/badge/status-active-00843D) ·
[![ci](https://github.com/bussetech/crm-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/bussetech/crm-demo/actions/workflows/ci.yml)
· **Site:** <https://crm-demo.bussetech.com> · **Visibility:** `public`

CRM Demo — a deliberately generic multi-tenant CRM (organizations, people, activities, deals) run as a live public demonstration of the studio's SaaS capability; synthetic data only, published demo logins.

A [Bussetech Software Studio](https://bussetech.com) project: a static site
(Jekyll, shared studio theme) rendered from text-based data stores.

## Layout

| path | what |
| --- | --- |
| `data/` | the datasets — JSON/YAML/CSV/Markdown, versioned in git |
| `schema/` | JSON Schemas; CI validates `data/<name>.*` against `schema/<name>.schema.json` |
| `_posts/` | site posts — each one becomes a `/feed.json` item the studio portal aggregates |
| `gnomes/` | project gnome directories (stub — see `gnomes/README.md`) |
| `.github/workflows/` | thin callers into the studio's shared CI + the Pages deploy |

## Build locally

```sh
bundle install
bundle exec jekyll serve      # http://127.0.0.1:4000
```

No studio access needed — the theme and CI machinery are public. See
`CLAUDE.md` for how this repo fits the studio (and how it detaches from it).

## Licenses

Code: MIT (`LICENSE`). Published datasets: CC BY 4.0 — license and
provenance statements live in `data/index.md`.
