// View-layer gates that need no database: the pure functions between a row
// and a rendered string. They are cheap, so they run in `npm test` with the
// domain gates — the stack proof (test/routes.test.ts) is then free to be
// about isolation rather than about date formatting.
import { describe, expect, it } from "vitest";

import { boardOf, searchTerm, type Deal } from "../src/views/model";
import {
  STAGE_LABEL,
  auditHref,
  auditLine,
  auditTarget,
  day,
  money,
  since,
  stamp,
} from "../src/views/format";
import { FLASH, currentNav } from "../src/ui/layout";
import { DEAL_STAGES } from "../src/domain/stages";

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
});

describe("the post-write confirmation", () => {
  it("is looked up by key, so nothing a visitor types can reach the page", () => {
    expect(FLASH["created"]).toBeTruthy();
    expect(FLASH["<script>alert(1)</script>"]).toBeUndefined();
  });

  it("has a message for every code the router redirects with", () => {
    // the router's vocabulary — keep in step with src/index.tsx
    for (const code of ["created", "updated", "stage", "reopened", "logged"]) {
      expect(FLASH[code], `no confirmation for ?saved=${code}`).toBeTruthy();
    }
  });
});
