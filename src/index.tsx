// crm-demo — Workers entry point (Hono + SSR JSX, the stratum shape).
// Founding scaffold (CRMDEMO-EPIC1-01): /healthz only — status + build id,
// never tenant data (ADR-0023 §4). Features arrive by later sessions;
// nothing here claims otherwise.
import { Hono } from "hono";

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  APP_BUILD_ID: string;
};

export const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) =>
  c.json({ ok: true, service: "crm-demo", build: c.env.APP_BUILD_ID ?? "dev" }),
);

export default app;
