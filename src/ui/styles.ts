// The app's stylesheet, served at /app.css so the Content-Security-Policy
// can forbid inline style and script outright (src/index.tsx). Tokens are
// PORTED from the studio theme (theme/tokens/design-tokens.yml) — the same
// values studio-portal's design system uses — so this app looks like it
// belongs to the studio without inventing a design system of its own
// (which would be a build nobody asked for).
//
// Colour is wayfinding: green = action, blue = information, orange =
// alert, and the stage colours below mean pipeline position, never
// decoration. There is no client-side JavaScript in this app at all.

export const APP_CSS = `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", "SFMono-Regular", ui-monospace, "Menlo", "Consolas", monospace;
  --t-xs: 0.75rem; --t-sm: 0.875rem; --t-base: 1rem; --t-md: 1.125rem;
  --t-lg: 1.375rem; --t-xl: 1.75rem;
  --s1: 0.25rem; --s2: 0.5rem; --s3: 0.75rem; --s4: 1rem; --s5: 1.5rem; --s6: 2rem; --s7: 3rem;
  --gray-100: #F2F2F0; --gray-200: #E6E6E3; --gray-300: #D9D9D6; --gray-500: #6B6B6B;
  --ground: #FFFFFF; --ground-alt: #FAFAF8; --ink: #1A1A1A; --ink-soft: #565656; --hairline: #D9D9D6;
  --action: #00843D; --action-strong: #006B31; --action-on: #FFFFFF; --action-surface: #E6F2EA;
  --info: #0055A4; --info-surface: #EAF1F8;
  --alert: #E87722; --alert-text: #A85410; --alert-surface: #FDF1E6;
  --status-red: #C8102E; --status-amber: #9A5B00; --status-green: #00843D;
  --r-sm: 2px; --r-md: 4px; --r-pill: 999px;
  --container: 76rem;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; font-family: var(--font-sans); font-size: var(--t-base); line-height: 1.55;
  color: var(--ink); background: var(--ground); -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p, ul, ol, figure { margin: 0; }
ul { list-style: none; padding: 0; }
a { color: var(--info); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--info); outline-offset: 2px; }
.num { font-variant-numeric: tabular-nums; }
.mono { font-family: var(--font-mono); font-size: var(--t-sm); }
.muted { color: var(--ink-soft); }
.eyebrow {
  text-transform: uppercase; letter-spacing: 0.04em; font-size: var(--t-xs);
  color: var(--ink-soft); font-weight: 500;
}
.skip {
  position: absolute; left: -9999px; top: 0; background: var(--ground); padding: var(--s2) var(--s3);
}
.skip:focus { left: var(--s3); top: var(--s3); z-index: 10; }

/* ── the synthetic-data banner: on every page, never dismissible ─────── */
.banner {
  background: var(--alert-surface); border-bottom: 1px solid var(--alert);
  color: var(--ink); font-size: var(--t-sm); padding: var(--s2) var(--s4);
}
.banner strong { color: var(--alert-text); }
.banner-inner { max-width: var(--container); margin: 0 auto; }

/* ── chrome ───────────────────────────────────────────────────────────── */
.topbar { border-bottom: 1px solid var(--hairline); background: var(--ground); }
.topbar-inner {
  max-width: var(--container); margin: 0 auto; padding: var(--s3) var(--s4);
  display: flex; flex-wrap: wrap; gap: var(--s4); align-items: baseline;
}
.brand { font-weight: 700; letter-spacing: -0.01em; color: var(--ink); font-size: var(--t-md); }
.brand:hover { text-decoration: none; }
.whoami { margin-left: auto; display: flex; align-items: baseline; gap: var(--s3); font-size: var(--t-sm); }
.tenant-name { font-weight: 500; }
.nav { border-bottom: 1px solid var(--hairline); background: var(--ground-alt); }
.nav-inner {
  max-width: var(--container); margin: 0 auto; padding: 0 var(--s4);
  display: flex; flex-wrap: wrap; gap: var(--s5);
}
.nav a {
  display: inline-block; padding: var(--s3) 0; color: var(--ink-soft);
  font-size: var(--t-sm); font-weight: 500; border-bottom: 2px solid transparent;
}
.nav a:hover { color: var(--ink); text-decoration: none; }
.nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--action); }

main { max-width: var(--container); margin: 0 auto; padding: var(--s6) var(--s4) var(--s7); }
.page-head { margin-bottom: var(--s5); }
.page-head h1 { font-size: var(--t-xl); letter-spacing: -0.02em; line-height: 1.2; }
.page-head p { color: var(--ink-soft); font-size: var(--t-sm); margin-top: var(--s1); }
.section { margin-top: var(--s6); }
.section > h2 { font-size: var(--t-md); margin-bottom: var(--s3); }
.crumb { font-size: var(--t-sm); margin-bottom: var(--s2); }

footer {
  border-top: 1px solid var(--hairline); background: var(--ground-alt);
  font-size: var(--t-xs); color: var(--ink-soft);
}
.footer-inner {
  max-width: var(--container); margin: 0 auto; padding: var(--s4);
  display: flex; flex-wrap: wrap; gap: var(--s4); justify-content: space-between;
}

/* ── tables ───────────────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: var(--t-sm); }
th, td { text-align: left; padding: var(--s2) var(--s3); border-bottom: 1px solid var(--hairline); }
th {
  font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--ink-soft); font-weight: 500; white-space: nowrap;
}
tbody tr:hover { background: var(--ground-alt); }
td.right, th.right { text-align: right; }

/* ── filter bar ───────────────────────────────────────────────────────── */
.filters {
  display: flex; flex-wrap: wrap; gap: var(--s3); align-items: flex-end;
  padding: var(--s3); background: var(--ground-alt); border: 1px solid var(--hairline);
  border-radius: var(--r-md); margin-bottom: var(--s4);
}
.field { display: flex; flex-direction: column; gap: var(--s1); }
.field label { font-size: var(--t-xs); color: var(--ink-soft); font-weight: 500; }
input[type="text"], input[type="search"], input[type="email"], input[type="password"], select {
  font: inherit; font-size: var(--t-sm); padding: var(--s2) var(--s3);
  border: 1px solid var(--gray-300); border-radius: var(--r-sm); background: var(--ground);
  color: var(--ink); min-width: 12rem;
}
button, .button {
  font: inherit; font-size: var(--t-sm); font-weight: 500; cursor: pointer;
  padding: var(--s2) var(--s4); border-radius: var(--r-sm);
  border: 1px solid var(--action); background: var(--action); color: var(--action-on);
}
button:hover, .button:hover { background: var(--action-strong); border-color: var(--action-strong); text-decoration: none; }
button.quiet, .button.quiet {
  background: var(--ground); color: var(--ink); border-color: var(--gray-300);
}
button.quiet:hover, .button.quiet:hover { background: var(--gray-100); }
.linklike {
  background: none; border: none; padding: 0; color: var(--info); font-weight: 400;
  text-decoration: underline; cursor: pointer;
}
.linklike:hover { background: none; color: var(--info); }

/* ── panels + facts ───────────────────────────────────────────────────── */
.panel {
  border: 1px solid var(--hairline); border-radius: var(--r-md);
  padding: var(--s4); background: var(--ground);
}
.grid { display: grid; gap: var(--s4); }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--s2) var(--s4); font-size: var(--t-sm); }
.facts dt { color: var(--ink-soft); }
.facts dd { margin: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--s3); }
.tile {
  border: 1px solid var(--hairline); border-radius: var(--r-md); padding: var(--s3);
  background: var(--ground-alt);
}
.tile .n { font-size: var(--t-lg); font-weight: 700; letter-spacing: -0.02em; display: block; }

/* ── badges: role + stage + activity type ─────────────────────────────── */
.badge {
  display: inline-block; font-size: var(--t-xs); font-weight: 500; padding: 0 var(--s2);
  border-radius: var(--r-pill); border: 1px solid var(--gray-300); color: var(--ink-soft);
  background: var(--ground); white-space: nowrap;
}
.badge.role-admin { border-color: var(--info); color: var(--info); background: var(--info-surface); }
.badge.role-manager { border-color: var(--action); color: var(--action-strong); background: var(--action-surface); }
.badge.inactive { border-color: var(--gray-300); color: var(--gray-500); background: var(--gray-100); }
.stage {
  display: inline-block; font-size: var(--t-xs); font-weight: 500; padding: 0 var(--s2);
  border-radius: var(--r-pill); border: 1px solid currentColor; white-space: nowrap;
}
.stage-lead, .stage-qualified, .stage-proposal, .stage-negotiation { color: var(--ink-soft); }
.stage-negotiation { color: var(--status-amber); }
.stage-won { color: var(--status-green); }
.stage-lost { color: var(--status-red); }

/* ── pipeline board ───────────────────────────────────────────────────── */
.board { display: grid; grid-template-columns: repeat(6, minmax(11rem, 1fr)); gap: var(--s3); }
.column { background: var(--ground-alt); border: 1px solid var(--hairline); border-radius: var(--r-md); }
.column > header {
  padding: var(--s3); border-bottom: 1px solid var(--hairline);
  border-top: 3px solid var(--gray-300); border-radius: var(--r-md) var(--r-md) 0 0;
}
.column.won > header { border-top-color: var(--status-green); }
.column.lost > header { border-top-color: var(--status-red); }
.column.negotiation > header { border-top-color: var(--status-amber); }
.column h2 { font-size: var(--t-sm); }
.column .meta { font-size: var(--t-xs); color: var(--ink-soft); }
.cards { padding: var(--s2); display: flex; flex-direction: column; gap: var(--s2); }
.card {
  background: var(--ground); border: 1px solid var(--hairline); border-radius: var(--r-sm);
  padding: var(--s2) var(--s3); font-size: var(--t-sm);
}
.card .title { font-weight: 500; display: block; }
/* block, not inline: the org line and the amount line ran together into
   "Gizmo Garden Supply$44,000" on the first real render of the board. */
.card .sub { display: block; font-size: var(--t-xs); color: var(--ink-soft); }
.card .amt { font-weight: 500; }
.column .empty { padding: var(--s3); font-size: var(--t-xs); color: var(--ink-soft); }
@media (max-width: 60rem) {
  .board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ── feeds + trails ───────────────────────────────────────────────────── */
.feed { display: flex; flex-direction: column; }
.feed li { padding: var(--s3) 0; border-bottom: 1px solid var(--hairline); }
.feed .subject { font-weight: 500; }
.feed .meta { font-size: var(--t-xs); color: var(--ink-soft); }
.trail li { padding: var(--s2) 0; border-bottom: 1px solid var(--hairline); font-size: var(--t-sm); }
.empty { color: var(--ink-soft); font-size: var(--t-sm); padding: var(--s3) 0; }

/* ── notes: information and refusal ───────────────────────────────────── */
.note {
  border-left: 4px solid var(--info); background: var(--info-surface);
  padding: var(--s3) var(--s4); font-size: var(--t-sm); border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.note.refusal { border-left-color: var(--status-red); background: var(--ground-alt); }
.note.ok { border-left-color: var(--status-green); background: var(--ground-alt); }

/* ── spacing utilities ────────────────────────────────────────────────
   These were inline style= attributes until CRMDEMO-EPIC1-04 drove the
   app in a real browser and found them BLOCKED: this app's own CSP is
   style-src 'self' with no 'unsafe-inline', which rejects style
   ATTRIBUTES as well as <style> blocks. They had never applied, on any
   page, since 03 — and no assertion was ever going to notice, because a
   test runner does not enforce a Content-Security-Policy header. */
.after { margin-top: var(--s4); }
.lede { margin-top: var(--s2); }
.lede-gap { margin-top: var(--s5); }
.filters .filler { margin-left: auto; }

/* ── write surfaces (04) ──────────────────────────────────────────────── */
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin: var(--s4) 0; }
.entry {
  display: flex; flex-direction: column; gap: var(--s4);
  padding: var(--s4); background: var(--ground-alt);
  border: 1px solid var(--hairline); border-radius: var(--r-md);
  max-width: 42rem;
}
.entry .field input, .entry .field select, .entry .field textarea { width: 100%; }
.entry .actions { margin: 0; }
input[type="number"], textarea {
  font: inherit; font-size: var(--t-sm); padding: var(--s2) var(--s3);
  border: 1px solid var(--gray-300); border-radius: var(--r-sm); background: var(--ground);
  color: var(--ink); min-width: 12rem;
}
textarea { resize: vertical; }
.hint { font-size: var(--t-xs); color: var(--ink-soft); display: block; }
.static-value { font-size: var(--t-sm); margin: 0; }

/* the stage control: a select of legal moves plus a button, no script */
.stage-move { display: flex; gap: var(--s2); align-items: center; margin-top: var(--s3); }
.stage-move.compact { margin-top: var(--s2); }
.stage-move.compact select {
  min-width: 0; width: 100%; font-size: var(--t-xs); padding: var(--s1) var(--s2);
}
.stage-move.compact button { font-size: var(--t-xs); padding: var(--s1) var(--s2); }
.reopen { display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s3); max-width: 34rem; }
.reopen input { width: 100%; }
.reopen button { align-self: flex-start; }

/* ── audit trail ──────────────────────────────────────────────────────── */
table.audit td { vertical-align: top; }
td.nowrap, th.nowrap { white-space: nowrap; }

/* visible to a screen reader, not to the page */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ── login ────────────────────────────────────────────────────────────── */
.login { max-width: 26rem; margin: var(--s7) auto; padding: 0 var(--s4); }
.login h1 { font-size: var(--t-xl); letter-spacing: -0.02em; }
.login form { display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s5); }
.login input { width: 100%; }
.login button { width: 100%; padding: var(--s3); }
`;
