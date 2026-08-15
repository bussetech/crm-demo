// View-layer gates that need no database: the pure functions between a row
// and a rendered string. They are cheap, so they run in `npm test` with the
// domain gates — the stack proof (test/routes.test.ts) is then free to be
// about isolation rather than about date formatting.
import { describe, expect, it } from "vitest";

import { boardOf, searchTerm, type ActivityPulse, type Deal } from "../src/views/model";
import {
  STAGE_LABEL,
  auditHref,
  auditLine,
  auditTarget,
  day,
  money,
  percent,
  since,
  stamp,
} from "../src/views/format";
import {
  WEEK_MS,
  activityByWeek,
  openPipeline,
  pipelineByOwner,
  pipelineByStage,
  winLoss,
} from "../src/views/reports";
import { BANNER_TEXT, PERSONA, RESET_POSTURE, demoTenants, resetCopy } from "../src/views/demo";
import { FLASH, currentNav } from "../src/ui/layout";
import { DEAL_STAGES } from "../src/domain/stages";
import { MEMBER_ROLES } from "../src/domain/roles";

const deal = (id: string, stage: Deal["stage"], amount: number): Deal => ({
  id,
  name: `deal ${id}`,
  amount,
  stage,
  ownerId: "owner",
  orgId: "org",
  orgName: "Org",
  closedAt: stage === "won" || stage === "lost" ? "2026-07-01T00:00:00Z" : null,
  updatedAt: "2026-07-01T00:00:00Z",
});

describe("the pipeline board", () => {
  it("has a column for every stage, in stage order, even when empty", () => {
    const columns = boardOf([deal("a", "lead", 100)]);
    expect(columns.map((col) => col.stage)).toEqual([...DEAL_STAGES]);
    expect(columns.filter((col) => col.deals.length === 0)).toHaveLength(DEAL_STAGES.length - 1);
  });

  it("totals each column from its own cards", () => {
    const columns = boardOf([
      deal("a", "proposal", 1000),
      deal("b", "proposal", 250),
      deal("c", "won", 5000),
    ]);
    const proposal = columns.find((col) => col.stage === "proposal")!;
    expect(proposal.deals).toHaveLength(2);
    expect(proposal.total).toBe(1250);
    expect(columns.find((col) => col.stage === "won")!.total).toBe(5000);
    expect(columns.find((col) => col.stage === "lost")!.total).toBe(0);
  });

  it("never loses a deal between the list and the board", () => {
    const deals = [deal("a", "lead", 1), deal("b", "lost", 2), deal("c", "negotiation", 3)];
    expect(boardOf(deals).flatMap((col) => col.deals)).toHaveLength(deals.length);
  });
});

describe("search terms are words, not patterns", () => {
  it("drops LIKE wildcards", () => {
    expect(searchTerm("100%_widget")).toBe("100 widget");
  });

  it("drops the characters PostgREST's filter grammar reads", () => {
    expect(searchTerm('a,b.c(d):e"f')).toBe("a b c d e f");
  });

  it("caps length so a query string cannot grow a request", () => {
    expect(searchTerm("x".repeat(500))).toHaveLength(60);
  });

  it("leaves an ordinary name alone", () => {
    expect(searchTerm("Cogwheel & Daughters")).toBe("Cogwheel & Daughters");
  });
});

describe("formatting is fixed, so a capture does not drift", () => {
  it("renders money without cents", () => {
    expect(money(21000)).toBe("$21,000");
  });

  it("renders dates in UTC regardless of where it runs", () => {
    expect(day("2026-07-22T23:30:00Z")).toBe("Jul 22, 2026");
    expect(stamp("2026-07-22T23:30:00Z")).toContain("UTC");
  });

  it("says how long ago in plain words", () => {
    const now = new Date("2026-07-22T12:00:00Z");
    expect(since("2026-07-22T09:00:00Z", now)).toBe("today");
    expect(since("2026-07-21T09:00:00Z", now)).toBe("yesterday");
    expect(since("2026-07-19T09:00:00Z", now)).toBe("3 days ago");
    expect(since("2026-05-19T09:00:00Z", now)).toBe("2 months ago");
  });

  it("reads an audit row back as the transition it recorded", () => {
    expect(auditLine("deal.stage_changed", { from: "negotiation", to: "won" })).toBe(
      "Negotiation → Won",
    );
    expect(auditLine("deal.reopened", { reason: "customer came back" })).toBe(
      "Reopened — customer came back",
    );
  });

  it("reads back the record writes 04 added to the vocabulary", () => {
    expect(auditLine("deal.created", { stage: "lead" })).toBe("Deal created at Lead");
    expect(auditLine("deal.updated", { changed: ["amount", "owner"] })).toBe(
      "Deal edited — amount, owner",
    );
    expect(auditLine("organization.created", {})).toBe("Organization added");
    expect(auditLine("person.updated", { changed: ["email"] })).toBe("Person edited — email");
    expect(auditLine("activity.logged", { type: "call" })).toBe("Call logged");
    expect(auditLine("membership.role_changed", { from: "rep", to: "manager" })).toBe(
      "Role changed — Rep → Manager",
    );
  });

  it("degrades to something readable rather than dropping a row it cannot phrase", () => {
    // a trail that silently omits rows is worse than a plain one
    expect(auditLine("membership.role_changed", {})).toBe("Role changed");
    expect(auditLine("something.new", {})).toBe("something.new");
  });

  it("names the record an audit row is about, from the row itself", () => {
    expect(auditTarget({ deal_name: "Widget Refresh Q3" })).toBe("Widget Refresh Q3");
    expect(auditTarget({ name: "Gizmo Garden Supply" })).toBe("Gizmo Garden Supply");
    expect(auditTarget({ subject: "Discovery call" })).toBe("Discovery call");
    expect(auditTarget({})).toBeNull();
  });

  it("links an audit row only where a reader has a page to open", () => {
    expect(auditHref("deal", "abc")).toBe("/deals/abc");
    expect(auditHref("organization", "abc")).toBe("/organizations/abc");
    expect(auditHref("person", "abc")).toBe("/people/abc");
    expect(auditHref("activity", "abc")).toBeNull();
    expect(auditHref("membership", "abc")).toBeNull();
    expect(auditHref("deal", null)).toBeNull();
  });

  it("labels every stage the domain knows", () => {
    for (const stage of DEAL_STAGES) expect(STAGE_LABEL[stage]).toBeTruthy();
  });
});

// ------------------------------------------------------------ the rollups

const owned = (id: string, stage: Deal["stage"], amount: number, ownerId: string): Deal => ({
  ...deal(id, stage, amount),
  ownerId,
});

describe("the manager rollups", () => {
  const book: Deal[] = [
    owned("a", "lead", 1000, "riley"),
    owned("b", "proposal", 2000, "riley"),
    owned("c", "negotiation", 4000, "sam"),
    owned("d", "won", 8000, "sam"),
    owned("e", "lost", 500, "riley"),
  ];

  it("gives every stage a row, including the ones with nothing in them", () => {
    const rows = pipelineByStage(book);
    expect(rows.map((r) => r.stage)).toEqual([...DEAL_STAGES]);
    expect(rows.find((r) => r.stage === "qualified")).toEqual({
      stage: "qualified",
      count: 0,
      value: 0,
    });
    expect(rows.find((r) => r.stage === "proposal")!.value).toBe(2000);
  });

  it("cuts the same deals by owner, and the two cuts agree", () => {
    const stages = pipelineByStage(book);
    const owners = pipelineByOwner(book);
    const stageValue = stages.reduce((total, r) => total + r.value, 0);
    const ownerValue = owners.reduce((total, r) => total + r.value, 0);
    expect(ownerValue).toBe(stageValue);
    expect(owners.reduce((total, r) => total + r.count, 0)).toBe(book.length);
  });

  it("counts open work separately from closed, per owner", () => {
    const riley = pipelineByOwner(book).find((r) => r.ownerId === "riley")!;
    expect(riley.count).toBe(3);
    expect(riley.value).toBe(3500);
    // the lost deal is theirs but is not pipeline
    expect(riley.openCount).toBe(2);
    expect(riley.openValue).toBe(3000);
  });

  it("ranks owners by the open value a manager is actually asking about", () => {
    expect(pipelineByOwner(book).map((r) => r.ownerId)).toEqual(["sam", "riley"]);
  });

  it("counts an owner who no longer holds a membership rather than losing the deal", () => {
    const withGhost = [...book, owned("f", "lead", 100, "departed")];
    const rows = pipelineByOwner(withGhost);
    expect(rows.find((r) => r.ownerId === "departed")!.count).toBe(1);
    expect(rows.reduce((total, r) => total + r.count, 0)).toBe(withGhost.length);
  });

  it("means the open stages by 'open pipeline'", () => {
    expect(openPipeline(book)).toEqual({ count: 3, value: 7000 });
  });

  it("has no win rate at all when nothing has closed", () => {
    // not 0%: a rate out of no closed deals would be a claim about
    // performance made from an absence of data
    const open = book.filter((d) => !d.closedAt);
    expect(winLoss(open).rate).toBeNull();
    expect(winLoss(open).closed).toHaveLength(0);
  });

  it("computes the win rate as won over closed, and nothing else", () => {
    const wl = winLoss(book);
    expect(wl.won).toBe(1);
    expect(wl.lost).toBe(1);
    expect(wl.wonValue).toBe(8000);
    expect(wl.rate).toBe(0.5);
    expect(percent(wl.rate!)).toBe("50%");
  });

  it("lists closed deals newest close first", () => {
    const older = { ...owned("g", "won", 1, "sam"), closedAt: "2026-01-01T00:00:00Z" };
    const newer = { ...owned("h", "lost", 1, "sam"), closedAt: "2026-08-01T00:00:00Z" };
    expect(winLoss([older, newer]).closed.map((d) => d.id)).toEqual(["h", "g"]);
  });
});

describe("activity volume", () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const agoDays = (days: number): string =>
    new Date(now.getTime() - days * 86_400_000).toISOString();
  const pulse = (type: ActivityPulse["type"], days: number): ActivityPulse => ({
    type,
    occurredAt: agoDays(days),
  });

  it("buckets by seven days back from now, oldest column first", () => {
    const volume = activityByWeek([pulse("call", 0), pulse("call", 8), pulse("note", 20)], now, 4);
    expect(volume.weeks).toHaveLength(4);
    expect(volume.weeks.map((w) => w.total)).toEqual([0, 1, 1, 1]);
    expect(new Date(volume.weeks[0]!.start).getTime()).toBe(now.getTime() - 4 * WEEK_MS);
    expect(volume.windowStart).toBe(new Date(now.getTime() - 4 * WEEK_MS).toISOString());
  });

  it("keeps every column the same seven days long, so their heights compare", () => {
    const volume = activityByWeek([], now, 4);
    for (const week of volume.weeks) {
      expect(new Date(week.end).getTime() - new Date(week.start).getTime()).toBe(WEEK_MS);
    }
  });

  it("counts by kind and in total, and finds the busiest week", () => {
    const volume = activityByWeek(
      [pulse("call", 1), pulse("call", 2), pulse("email", 3), pulse("note", 9)],
      now,
      4,
    );
    expect(volume.total).toBe(4);
    expect(volume.byType.call).toBe(2);
    expect(volume.byType.meeting).toBe(0);
    expect(volume.peak).toBe(3);
    expect(volume.weeks.at(-1)!.byType.call).toBe(2);
  });

  it("ignores what falls outside the window rather than piling it into the last column", () => {
    const volume = activityByWeek([pulse("call", 1), pulse("call", 400)], now, 4);
    expect(volume.total).toBe(1);
    expect(volume.weeks[0]!.total).toBe(0);
  });

  it("files a row stamped a moment ahead of the clock under the current week", () => {
    const ahead: ActivityPulse = { type: "note", occurredAt: agoDays(-0.01) };
    const volume = activityByWeek([ahead], now, 4);
    expect(volume.weeks.at(-1)!.total).toBe(1);
    expect(volume.total).toBe(1);
  });
});

// ------------------------------------------------------------ the front door

describe("the published demo logins", () => {
  const tenants = demoTenants();

  it("publishes every seeded account of every tenant", () => {
    expect(tenants.length).toBeGreaterThanOrEqual(2);
    for (const tenant of tenants) {
      expect(tenant.logins.length, `${tenant.slug} publishes nothing`).toBeGreaterThan(0);
    }
  });

  it("publishes only undeliverable addresses, so no real inbox can be named", () => {
    for (const tenant of tenants) {
      for (const login of tenant.logins) {
        expect(login.email.endsWith(".example"), login.email).toBe(true);
        expect(login.password.length).toBeGreaterThan(8);
      }
    }
  });

  it("publishes the deactivated accounts too — refusal is a demo beat", () => {
    const deactivated = tenants.flatMap((t) => t.logins.filter((l) => !l.active));
    expect(deactivated.length).toBeGreaterThan(0);
  });

  it("says what every role in the vocabulary is for", () => {
    for (const role of MEMBER_ROLES) expect(PERSONA[role]).toBeTruthy();
  });

  it("states the reset posture the app is actually in, not the one that was ruled", () => {
    // The honest-capture switch. CRMDEMO-EPIC1-06 flips `scheduled` when
    // the job ships; until then both the banner and the credentials page
    // have to say the schedule is not running, and this is what makes
    // flipping one without the other a failing test rather than a lie on
    // the public front door.
    if (RESET_POSTURE.scheduled) {
      expect(resetCopy()).toContain(RESET_POSTURE.cadence);
      expect(BANNER_TEXT).toContain("resets on schedule");
    } else {
      expect(resetCopy()).toContain("not running yet");
      expect(BANNER_TEXT).not.toContain("resets on schedule");
    }
  });
});

describe("wayfinding", () => {
  it("marks the section a path belongs to", () => {
    expect(currentNav("/")).toBe("/");
    expect(currentNav("/organizations")).toBe("/organizations");
    expect(currentNav("/organizations/abc")).toBe("/organizations");
    expect(currentNav("/people/abc")).toBe("/people");
    expect(currentNav("/activities?type=call")).toBe("/activities");
  });

  it("prefers the longest match, so the board is not filed under deals", () => {
    expect(currentNav("/deals/board")).toBe("/deals/board");
    expect(currentNav("/deals/some-id")).toBe("/deals");
  });

  it("files the write surfaces under the section they write to", () => {
    expect(currentNav("/organizations/new")).toBe("/organizations");
    expect(currentNav("/people/abc/edit")).toBe("/people");
    expect(currentNav("/activities/new")).toBe("/activities");
    expect(currentNav("/audit")).toBe("/audit");
  });

  it("files the 05 surfaces under themselves", () => {
    expect(currentNav("/reports")).toBe("/reports");
    expect(currentNav("/admin/users")).toBe("/admin/users");
    expect(currentNav("/admin/users/abc/role")).toBe("/admin/users");
  });
});

describe("the post-write confirmation", () => {
  it("is looked up by key, so nothing a visitor types can reach the page", () => {
    expect(FLASH["created"]).toBeTruthy();
    expect(FLASH["<script>alert(1)</script>"]).toBeUndefined();
  });

  it("has a message for every code the router redirects with", () => {
    // the router's vocabulary — keep in step with src/index.tsx
    for (const code of [
      "created",
      "updated",
      "stage",
      "reopened",
      "logged",
      "role",
      "deactivated",
      "activated",
    ]) {
      expect(FLASH[code], `no confirmation for ?saved=${code}`).toBeTruthy();
    }
  });
});
