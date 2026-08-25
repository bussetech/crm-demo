// Structural gates — assertions about the SHAPE of the code, not its
// behaviour. The acceptance criterion for CRMDEMO-EPIC1-04 asks for a
// grep-level check that write handlers do not inline business rules, and
// this is it, kept honest as a test rather than a habit.
//
// These pass trivially today. They exist for the change six months from
// now that adds `if (role === "manager")` to a handler because it was
// quicker than importing the domain module — the moment the twin rules
// (pure TS + database) stop being the only two places a rule lives.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEAL_STAGES } from "../src/domain/stages";
import { MEMBER_ROLES } from "../src/domain/roles";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

/**
 * Comments are prose about the rules and SHOULD name them — "won/lost are
 * terminal" is exactly the sort of sentence this file wants to encourage.
 * Only executable text is searched.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const router = stripComments(read("src/index.tsx"));
const writes = stripComments(read("src/views/writes.ts"));
const model = stripComments(read("src/views/model.ts"));

/** A whole quoted token, so page prose about "admins" is not a hit. */
const quoted = (word: string) => new RegExp(`(["'\`])${word}\\1`);

describe("handlers do not inline business rules", () => {
  it.each([...MEMBER_ROLES])(
    "the router never names the role %s — capability comes from domain/roles",
    (role) => {
      expect(quoted(role).test(router), `src/index.tsx hard-codes "${role}"`).toBe(false);
    },
  );

  it.each([...DEAL_STAGES])(
    "the router never names the stage %s — legality comes from domain/stages",
    (stage) => {
      expect(quoted(stage).test(router), `src/index.tsx hard-codes "${stage}"`).toBe(false);
    },
  );

  it.each([...MEMBER_ROLES, ...DEAL_STAGES])(
    "the write model never names %s either — it asks, it does not judge",
    (word) => {
      expect(quoted(word).test(writes), `src/views/writes.ts hard-codes "${word}"`).toBe(false);
    },
  );

  it("the write model does not consult the transition rule before writing", () => {
    // setDealStage hands the move to the database UNJUDGED on purpose: it
    // is what makes a crafted request meet the same refusal as a form.
    expect(writes).not.toContain("isTransitionAllowed");
    expect(writes).not.toContain("allowedTransitions");
  });

  it("the router imports its rules rather than restating them", () => {
    for (const module of ["./domain/roles", "./domain/stages", "./domain/activity"]) {
      expect(router).toContain(module);
    }
  });
});

describe("no tenant id ever comes from a request", () => {
  it("the router never mentions tenant_id at all", () => {
    expect(router).not.toContain("tenant_id");
  });

  it("the read model still takes no tenant id (the 03 law, still true)", () => {
    expect(model).not.toContain("tenant_id");
  });

  it("every tenant_id the write model sets comes from the signed-in profile", () => {
    const assignments = writes.match(/tenant_id:[^,\n]*/g) ?? [];
    expect(assignments.length, "the write model sets no tenant_id at all").toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment.replace(/\s+/g, " ").trim()).toBe("tenant_id: profile.tenant.id");
    }
  });
});

describe("nothing renders what this app's own CSP will throw away", () => {
  // Found by driving a real browser at CRMDEMO-EPIC1-04, not by 165 green
  // assertions: `style-src 'self'` rejects style ATTRIBUTES as well as
  // <style> blocks, so every inline style in the app had been silently
  // dropped since 03. A test runner never enforces a CSP; this grep does.
  it.each([
    "src/ui/pages.tsx",
    "src/ui/forms.tsx",
    "src/ui/layout.tsx",
    "src/ui/reports.tsx",
    "src/ui/admin.tsx",
    "src/ui/demo.tsx",
  ])("%s uses classes, never a style attribute", (file) => {
    expect(read(file)).not.toContain("style=");
  });

  it("the chart is drawn with geometry, not with the one thing the CSP drops", () => {
    // An SVG column chart is the CSP-shaped way to draw a bar: width and
    // height are ATTRIBUTES on markup, where `style="width:42%"` is the
    // blocked-since-03 kind. Keep it that way.
    const chart = read("src/ui/reports.tsx");
    expect(chart).toContain("viewBox");
    expect(chart).not.toContain("style=");
    expect(chart).not.toContain("<script");
  });

  it("the policy that makes that true is still the policy", () => {
    expect(router).toContain("style-src 'self'");
    expect(router).toContain("default-src 'none'");
    // no escape hatch anywhere in the router, CSP or otherwise
    expect(router).not.toContain("unsafe-");
  });
});

describe("the service plane stays out of the request path", () => {
  it.each([
    "src/index.tsx",
    "src/env.ts",
    "src/db.ts",
    "src/auth.ts",
    "src/limits.ts",
    "src/views/writes.ts",
    "src/views/model.ts",
  ])("%s cannot reach for a service-role key", (file) => {
    expect(read(file)).not.toContain("SERVICE_ROLE");
  });

  it("the binding surface has no field a service-role client could be built from", () => {
    const env = read("src/env.ts");
    expect(env).toContain("SUPABASE_ANON_KEY");
    expect(env.toLowerCase()).not.toContain("service");
  });

  // CRMDEMO-EPIC1-06: the reset job DOES hold the service-role key — in
  // the JOB PLANE (src/worker.ts + src/jobs/*), which the app router
  // never imports. These gates keep the two planes two.
  it("only the job plane and the seed engine may name the service-role binding", () => {
    const allowed = new Set(["src/worker.ts", "src/jobs/reset.ts", "src/seed/runner.ts"]);
    const walk = (dir: string): string[] =>
      readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
      );
    const offenders = walk("src").filter(
      (file) => !allowed.has(file) && read(file).includes("SERVICE_ROLE"),
    );
    expect(offenders).toEqual([]);
  });

  it("the app router never imports the job plane", () => {
    expect(router).not.toContain("jobs/reset");
    expect(router).not.toContain("./worker");
  });

  it("the job plane's dispatch doors are token-gated and closed by default", () => {
    const workerSource = read("src/worker.ts");
    expect(workerSource).toContain("RESET_DISPATCH_TOKEN");
    // the unprovisioned surface answers 404 — asserted behaviourally in
    // test/limits.test.ts; here we pin that the gate exists at all
    expect(workerSource).toContain("404");
  });
});
