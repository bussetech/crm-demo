// Founding scaffold test: the /healthz contract (status + build id, no
// tenant data — ADR-0023 §4). Proves the test harness runs; real suites
// (domain gates, the isolation proof) arrive with the schema sessions.
import { describe, expect, it } from "vitest";

import { app } from "../src/index";

const env = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "", APP_BUILD_ID: "test" };

describe("/healthz", () => {
  it("returns ok + service + build id and nothing else", async () => {
    const res = await app.request("/healthz", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "crm-demo", build: "test" });
  });

  it("serves nothing else yet — no accidental surface", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(404);
  });
});
