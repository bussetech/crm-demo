// Containment gates (CRMDEMO-EPIC1-06, track law 3) — provable without a
// database: the rate-limit floor, the multipart refusal, the body cap,
// the crawl policy, and the job plane's closed-until-provisioned doors.
//
// The limiter tests name their callers with `cf-connecting-ip` because
// that is the key Cloudflare's edge sets; requests without it (the rest
// of this suite, and the stack proofs) are deliberately not counted —
// src/limits.ts explains why that is honest rather than a hole.
import { describe, expect, it } from "vitest";

import { app } from "../src/index";
import worker, { JOB_ROUTES } from "../src/worker";
import { LOGIN_RATE, WRITE_RATE, createLimiter } from "../src/limits";

const env = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "", APP_BUILD_ID: "test" };

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

const postLogin = (ip?: string) =>
  app.request(
    "/login",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      // empty credentials: refused by the handler before any database work
      body: "email=&password=",
    },
    env,
  );

const postLogout = (ip: string) =>
  app.request(
    "/logout",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
      },
      body: "",
    },
    env,
  );

describe("the limiter (unit)", () => {
  it("allows up to the limit in a window, then refuses", () => {
    const limiter = createLimiter({ limit: 3, windowMs: 1000 });
    const t0 = 1_000_000;
    expect(limiter.take("a", t0)).toBe(true);
    expect(limiter.take("a", t0 + 1)).toBe(true);
    expect(limiter.take("a", t0 + 2)).toBe(true);
    expect(limiter.take("a", t0 + 3)).toBe(false);
  });

  it("counts each key alone", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 1000 });
    const t0 = 1_000_000;
    expect(limiter.take("a", t0)).toBe(true);
    expect(limiter.take("b", t0)).toBe(true);
    expect(limiter.take("a", t0 + 1)).toBe(false);
  });

  it("forgets a key when its window has passed", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 1000 });
    const t0 = 1_000_000;
    expect(limiter.take("a", t0)).toBe(true);
    expect(limiter.take("a", t0 + 1)).toBe(false);
    expect(limiter.take("a", t0 + 1000)).toBe(true);
  });

  it("names a sane Retry-After", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    limiter.take("a", t0);
    const after = limiter.retryAfterSeconds("a", t0 + 30_000);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(60);
  });
});

describe("rate limiting at the routes", () => {
  it(`refuses the ${LOGIN_RATE.limit + 1}th sign-in attempt from one caller with a 429 + Retry-After`, async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < LOGIN_RATE.limit; i++) {
      expect((await postLogin(ip)).status).toBe(401);
    }
    const refused = await postLogin(ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("another caller is not punished for the first one's flood", async () => {
    const ip = "203.0.113.11";
    for (let i = 0; i < LOGIN_RATE.limit + 2; i++) await postLogin("203.0.113.12");
    expect((await postLogin(ip)).status).toBe(401);
  });

  it("write routes share the wider write window", async () => {
    const ip = "203.0.113.13";
    for (let i = 0; i < WRITE_RATE.limit; i++) {
      expect((await postLogout(ip)).status).toBe(303);
    }
    expect((await postLogout(ip)).status).toBe(429);
  });

  it("a caller the edge has not named is not counted (tests and wrangler dev included)", async () => {
    for (let i = 0; i < LOGIN_RATE.limit + 3; i++) {
      expect((await postLogin()).status).toBe(401);
    }
  });
});

describe("no uploads, structurally", () => {
  it("refuses a multipart body before reading it", async () => {
    const res = await app.request(
      "/login",
      {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "--x--",
      },
      env,
    );
    expect(res.status).toBe(415);
  });

  it("still caps the declared body size", async () => {
    const res = await app.request(
      "/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "100000",
        },
        body: "email=&password=",
      },
      env,
    );
    expect(res.status).toBe(413);
  });
});

describe("the crawl policy", () => {
  it("invites crawlers to exactly one page: the front door", async () => {
    const res = await app.request("/robots.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Allow: /demo");
    expect(body).toContain("Disallow: /");
  });

  it("the front door is indexable; everything else keeps its noindex", async () => {
    const demo = await (await app.request("/demo", {}, env)).text();
    expect(demo).not.toContain("noindex");
    const login = await (await app.request("/login", {}, env)).text();
    expect(login).toContain('name="robots" content="noindex"');
  });
});

describe("the job plane's doors (closed until provisioned)", () => {
  const post = (path: string, jobEnv: object, token?: string) =>
    worker.fetch(
      new Request(`https://demo.local${path}`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      jobEnv as never,
      ctx,
    );

  it.each([...JOB_ROUTES])("%s does not exist without RESET_DISPATCH_TOKEN", async (path) => {
    expect((await post(path, env)).status).toBe(404);
  });

  it("refuses a wrong token without saying anything else", async () => {
    const res = await post("/jobs/reset", { ...env, RESET_DISPATCH_TOKEN: "right" }, "wrong");
    expect(res.status).toBe(403);
  });

  it("refuses a missing bearer entirely", async () => {
    const res = await post("/jobs/reset", { ...env, RESET_DISPATCH_TOKEN: "right" });
    expect(res.status).toBe(403);
  });

  it("a correct token against an unprovisioned service plane is a loud 503, not a crash", async () => {
    const res = await post("/jobs/reset", { ...env, RESET_DISPATCH_TOKEN: "right" }, "right");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("only POST exists on the job plane", async () => {
    const res = await worker.fetch(
      new Request("https://demo.local/jobs/reset", { method: "GET" }),
      { ...env, RESET_DISPATCH_TOKEN: "right" } as never,
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("a path under /jobs/ that is not a job is 404 even when provisioned", async () => {
    const res = await post("/jobs/self-destruct", { ...env, RESET_DISPATCH_TOKEN: "right" }, "right");
    expect(res.status).toBe(404);
  });

  it("the app plane is untouched by the wrapper", async () => {
    const res = await worker.fetch(
      new Request("https://demo.local/healthz"),
      env as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "crm-demo" });
  });
});
