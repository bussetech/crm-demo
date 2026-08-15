// The manager surfaces (CRMDEMO-EPIC1-05) — three rollups, rendered.
//
// Same rule as every other page in this app: a pure function of rows
// already fetched through the signed-in user's JWT. The derivations come
// from src/views/reports.ts, so what is rendered here is arithmetic over
// this tenant's own rows and nothing else — every number on this screen
// reconciles to the seed exactly, and a test says so.
//
// The chart is INLINE SVG on purpose. This app's CSP is `default-src
// 'none'; style-src 'self'` with no script source at all, which rules out
// a charting library, a canvas, and (the CRMDEMO-EPIC1-04 lesson) any bar
// sized by an inline width declaration — a style ATTRIBUTE is blocked
// exactly like a <style> block, which is why the grep in
// test/source.test.ts forbids the string outright, comments included.
// SVG geometry is markup rather than style, so it survives the policy; the
// fills come from classes in the stylesheet; and every number is repeated
// in a table below, so nothing is gated behind the picture.

import { ACTIVITY_TYPES } from "../domain/activity";
import type { Deal, Member } from "../views/model";
import {
  activityByWeek,
  openPipeline,
  pipelineByOwner,
  pipelineByStage,
  winLoss,
  type ActivityVolume,
} from "../views/reports";
import {
  ACTIVITY_LABEL,
  STAGE_LABEL,
  day,
  dayShort,
  money,
  percent,
  stamp,
} from "../views/format";
import { Empty, PageHead } from "./layout";
import { StageBadge } from "./pages";

type Roster = Map<string, Member>;

const memberName = (roster: Roster, userId: string): string =>
  roster.get(userId)?.displayName ?? "—";

/** How many closed deals the table shows. The rate is computed from all of them. */
const RECENT_CLOSED = 8;

/**
 * Every section carries one of these. A rollup without a timestamp invites
 * a reader to assume it is live, cached, nightly — whichever they are used
 * to. This one is none of those: it was computed when the page was asked
 * for, from rows read at that moment.
 */
function AsOf({ now, rows }: { now: Date; rows: number }) {
  return (
    <p class="as-of">
      Computed at page load from {rows} row{rows === 1 ? "" : "s"} · {stamp(now.toISOString())}
    </p>
  );
}

/**
 * The database was asked how many rows match, and handed back more than
 * this page read. It has never happened with the demo's data — the cap is
 * far above it — but a report that summed a truncated page and said
 * nothing would be the `/audit` overclaim wearing a different hat.
 */
function Truncated({ read, total }: { read: number; total: number }) {
  return (
    <p class="note refusal" role="alert">
      This rollup covers the {read} rows this page read, but the database reports {total} matching
      rows. The totals below are therefore incomplete — treat them as a floor, not a count.
    </p>
  );
}

// ------------------------------------------------------------ the chart

const CHART = {
  width: 640,
  height: 200,
  padX: 8,
  // headroom for the direct label that rides the tallest column: at a
  // smaller top the busiest week's number painted outside the viewBox and
  // was clipped by the box — visible in a screenshot, invisible to a test
  top: 28,
  baseline: 158,
  tickY: 178,
  barMax: 24,
  radius: 4,
} as const;

/** A column with a 4px rounded cap and square feet on the baseline. */
const columnPath = (x: number, y: number, w: number, bottom: number): string => {
  const r = Math.min(CHART.radius, w / 2, Math.max(bottom - y, 0));
  return [
    `M${x} ${bottom}`,
    `V${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `H${x + w - r}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `V${bottom}`,
    "Z",
  ].join(" ");
};

/**
 * Weekly totals as columns. One series, so no legend — the heading says
 * what is plotted — and one direct label, on the tallest column, because a
 * number over every bar is chaos and the table beneath carries the rest.
 * Each column has a <title>, which is the only tooltip a page with no
 * JavaScript can offer and the one browsers render natively.
 */
function VolumeChart({ volume }: { volume: ActivityVolume }) {
  const weeks = volume.weeks;
  if (volume.total === 0) return <Empty what="activity in this window" />;

  const plot = CHART.width - CHART.padX * 2;
  const band = plot / weeks.length;
  const barWidth = Math.min(CHART.barMax, band - 8);
  const span = CHART.baseline - CHART.top;
  const peak = Math.max(volume.peak, 1);

  return (
    <div class="chart">
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={`Activities logged per week for the last ${weeks.length} weeks; busiest week ${volume.peak}`}
      >
        <line
          class="axis"
          x1={CHART.padX}
          y1={CHART.baseline}
          x2={CHART.width - CHART.padX}
          y2={CHART.baseline}
        />
        {weeks.map((week, i) => {
          const height = Math.round((week.total / peak) * span);
          const x = CHART.padX + band * i + (band - barWidth) / 2;
          const y = CHART.baseline - height;
          const isPeak = week.total === volume.peak && volume.peak > 0;
          return (
            <>
              {week.total > 0 ? (
                <path class="bar" d={columnPath(x, y, barWidth, CHART.baseline)}>
                  <title>
                    {dayShort(week.start)}–{dayShort(week.end)}: {week.total} logged
                  </title>
                </path>
              ) : null}
              {isPeak ? (
                <text class="cap" x={x + barWidth / 2} y={y - 6} text-anchor="middle">
                  {week.total}
                </text>
              ) : null}
              <text class="tick" x={x + barWidth / 2} y={CHART.tickY} text-anchor="middle">
                {dayShort(week.start)}
              </text>
            </>
          );
        })}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------ the page

export function ReportsPage(props: {
  tenantName: string;
  now: Date;
  deals: Deal[];
  dealsTotal: number;
  dealsComplete: boolean;
  volume: ActivityVolume;
  activityTotal: number;
  activityComplete: boolean;
  weeks: number;
  roster: Roster;
}) {
  const stages = pipelineByStage(props.deals);
  const owners = pipelineByOwner(props.deals);
  const open = openPipeline(props.deals);
  const wl = winLoss(props.deals);
  const allValue = stages.reduce((total, row) => total + row.value, 0);

  return (
    <>
      <PageHead
        title="Reports"
        sub={`${props.tenantName} — the pipeline as numbers. Every figure on this page is a sum of rows the database handed your sign-in when you asked for it; nothing here is stored, cached or carried forward.`}
      />

      {/* ── 1. pipeline ─────────────────────────────────────────────── */}
      <section class="section">
        <h2>Pipeline by stage</h2>
        <AsOf now={props.now} rows={props.deals.length} />
        {props.dealsComplete ? null : (
          <Truncated read={props.deals.length} total={props.dealsTotal} />
        )}
        <div class="tiles">
          <div class="tile">
            <span class="n num">{open.count}</span>
            <span class="eyebrow">Open deals</span>
          </div>
          <div class="tile">
            <span class="n num">{money(open.value)}</span>
            <span class="eyebrow">Open pipeline</span>
          </div>
          <div class="tile">
            <span class="n num">{props.deals.length}</span>
            <span class="eyebrow">Deals all-time</span>
          </div>
          <div class="tile">
            <span class="n num">{money(allValue)}</span>
            <span class="eyebrow">Value all-time</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="report">
            <thead>
              <tr>
                <th>Stage</th>
                <th class="right">Deals</th>
                <th class="right">Value</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((row) => (
                <tr>
                  <td>
                    <a href={`/deals?stage=${row.stage}`}>
                      <StageBadge stage={row.stage} />
                    </a>
                  </td>
                  <td class="right num">{row.count}</td>
                  <td class="right num">{money(row.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>All stages</th>
                <td class="right num">{props.deals.length}</td>
                <td class="right num">{money(allValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <h3 class="sub-head">The same deals, by owner</h3>
        <div class="table-wrap">
          <table class="report">
            <thead>
              <tr>
                <th>Owner</th>
                <th class="right">Open</th>
                <th class="right">Open value</th>
                <th class="right">Deals</th>
                <th class="right">Value</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((row) => (
                <tr>
                  <td>
                    <a href={`/deals?owner=${row.ownerId}`}>{memberName(props.roster, row.ownerId)}</a>
                  </td>
                  <td class="right num">{row.openCount}</td>
                  <td class="right num">{money(row.openValue)}</td>
                  <td class="right num">{row.count}</td>
                  <td class="right num">{money(row.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Everyone</th>
                <td class="right num">{open.count}</td>
                <td class="right num">{money(open.value)}</td>
                <td class="right num">{props.deals.length}</td>
                <td class="right num">{money(allValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="muted after">
          Both tables cover the same deals, so their totals agree — a manager checking this app's
          arithmetic against itself is welcome to.
        </p>
      </section>

      {/* ── 2. activity volume ──────────────────────────────────────── */}
      <section class="section">
        <h2>Activity logged, week by week</h2>
        <AsOf now={props.now} rows={props.volume.total} />
        {props.activityComplete ? null : (
          <Truncated read={props.volume.total} total={props.activityTotal} />
        )}
        <p class="muted">
          Seven-day buckets counted back from now, oldest first — not calendar weeks, so every
          column covers the same seven days and their heights compare. Window opens{" "}
          {day(props.volume.windowStart)}.
        </p>
        <VolumeChart volume={props.volume} />
        <div class="table-wrap">
          <table class="report">
            <thead>
              <tr>
                <th>Week of</th>
                {ACTIVITY_TYPES.map((type) => (
                  <th class="right">{ACTIVITY_LABEL[type] ?? type}</th>
                ))}
                <th class="right">Total</th>
              </tr>
            </thead>
            <tbody>
              {props.volume.weeks.map((week) => (
                <tr>
                  <td class="nowrap">{day(week.start)}</td>
                  {ACTIVITY_TYPES.map((type) => (
                    <td class="right num">{week.byType[type]}</td>
                  ))}
                  <td class="right num">{week.total}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{props.weeks} weeks</th>
                {ACTIVITY_TYPES.map((type) => (
                  <td class="right num">{props.volume.byType[type]}</td>
                ))}
                <td class="right num">{props.volume.total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ── 3. win / loss ───────────────────────────────────────────── */}
      <section class="section">
        <h2>Won and lost</h2>
        <AsOf now={props.now} rows={wl.closed.length} />
        {wl.rate === null ? (
          <p class="note">
            Nothing has closed in this tenant yet, so there is no win rate to show. A rate computed
            from no closed deals would be a claim about performance made out of an absence of data.
          </p>
        ) : (
          <>
            <div class="tiles">
              <div class="tile">
                <span class="n num">{percent(wl.rate)}</span>
                <span class="eyebrow">Win rate</span>
              </div>
              <div class="tile">
                <span class="n num">{wl.won}</span>
                <span class="eyebrow">Won</span>
              </div>
              <div class="tile">
                <span class="n num">{wl.lost}</span>
                <span class="eyebrow">Lost</span>
              </div>
              <div class="tile">
                <span class="n num">{money(wl.wonValue)}</span>
                <span class="eyebrow">Won value</span>
              </div>
            </div>
            <p class="muted after">
              {wl.won} won of {wl.closed.length} closed, all time — the rate is that division and
              nothing else. Reopened deals are counted where they stand now, not where they have
              been.
            </p>
          </>
        )}

        <h3 class="sub-head">Recently closed</h3>
        {wl.closed.length === 0 ? (
          <Empty what="closed deals" />
        ) : (
          <div class="table-wrap">
            <table class="report">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Owner</th>
                  <th>Outcome</th>
                  <th class="right">Amount</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {wl.closed.slice(0, RECENT_CLOSED).map((deal) => (
                  <tr>
                    <td>
                      <a href={`/deals/${deal.id}`}>{deal.name}</a>
                    </td>
                    <td>{memberName(props.roster, deal.ownerId)}</td>
                    <td>
                      <StageBadge stage={deal.stage} />
                    </td>
                    <td class="right num">{money(deal.amount)}</td>
                    <td class="nowrap">{deal.closedAt ? day(deal.closedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {wl.closed.length > RECENT_CLOSED ? (
          <p class="muted after">
            The {RECENT_CLOSED} most recent of {wl.closed.length} closed deals. The rate above is
            computed from all {wl.closed.length}, not from this list.
          </p>
        ) : null}
      </section>

      <p class="note after">
        These rollups are offered to managers and tenant admins. They are not a confidentiality
        boundary: every member of this tenant can already read the same deals and activities one at
        a time, so a rep could add them up by hand. What the database keeps to itself is a
        different list — another tenant's rows, and this tenant's audit trail.
      </p>
    </>
  );
}
