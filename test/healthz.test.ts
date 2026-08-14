// The /healthz contract (ADR-0023 §4: unauthenticated, cheap, no side
// effects, status + build id, never tenant data) plus the shape of the
// public edge — all of it provable without a database, which is the point:
// a probe that needed a stack to answer would not be a probe.
import { describe, expect, it } from "vitest";

import { app } from "../src/index";

const env = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "", APP_BUILD_ID: "test" };

describe("/healthz", () => {
  it("returns ok + service + build id and nothing else", async () => {
    const res = await app.request("/healthz", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "crm-demo", build: "test" });
  });

  it("answers without touching the database", async () => {
    // SUPABASE_URL is empty above: any query would throw. It returns 200.
    const res = await app.request("/healthz", {}, env);
    expect(res.status).toBe(200);
  });
});

describe("the public edge", () => {
  it("sends an anonymous reader to the login page, remembering where they were", async () => {
    const res = await app.request("/organizations?q=gizmo", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Forganizations%3Fq%3Dgizmo");
  });

  it("sends an anonymous reader at the root to the login page with no query tail", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("serves the stylesheet as a real route so the CSP can forbid inline style", async () => {
    const res = await app.request("/app.css", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("content-security-policy")).toContain("style-src 'self'");
  });

  it("ships security headers on every response", async () => {
    const res = await app.request("/login", {}, env);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // Pinned deliberately: `no-referrer` makes browsers send `Origin: null`
    // on form posts, and the CSRF check would then refuse every sign-in.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("has no sign-up surface at all", async () => {
    for (const path of ["/signup", "/register", "/sign-up"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login");
    }
  });
});
