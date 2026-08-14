// Session handling: Supabase Auth JWTs in httpOnly cookies. Accounts are
// seed-provisioned (signup disabled in supabase/config.toml); there is no
// self-signup surface anywhere in this app, by construction. The JWT rides
// every database query (src/db.ts), so RLS — not this middleware — is the
// authorization boundary. Route guards below are WAYFINDING: they decide
// where to send a request, never what a query may see.

import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { SupabaseClient } from "@supabase/supabase-js";

import { anonClient, toOne, userClient } from "./db";
import type { CrmProfile, Env } from "./env";
import type { MemberRole } from "./domain/roles";

export interface AuthVars {
  db: SupabaseClient;
  profile: CrmProfile;
}

export type AppContext = Context<{ Bindings: Env; Variables: Partial<AuthVars> }>;

const ACCESS_COOKIE = "crm-access";
const REFRESH_COOKIE = "crm-refresh";

function cookieOpts(c: AppContext) {
  const secure = new URL(c.req.url).protocol === "https:";
  return { httpOnly: true, secure, sameSite: "Lax" as const, path: "/" };
}

export function setSessionCookies(c: AppContext, accessToken: string, refreshToken: string): void {
  setCookie(c, ACCESS_COOKIE, accessToken, { ...cookieOpts(c), maxAge: 60 * 60 });
  setCookie(c, REFRESH_COOKIE, refreshToken, { ...cookieOpts(c), maxAge: 60 * 60 * 24 * 7 });
}

export function clearSessionCookies(c: AppContext): void {
  deleteCookie(c, ACCESS_COOKIE, { path: "/" });
  deleteCookie(c, REFRESH_COOKIE, { path: "/" });
}

type MembershipRow = {
  id: string;
  role: MemberRole;
  display_name: string;
  tenant_id: string;
  tenants: { slug: string; name: string } | { slug: string; name: string }[] | null;
};

/**
 * The profile is the user's ACTIVE membership, read through their own JWT.
 * A deactivated user authenticates fine (the account is valid) and then
 * reads zero membership rows — `crm_is_member` is false for them — so this
 * resolves to null and the app refuses the session. Deactivation is total
 * because the database says so, not because a flag is checked here.
 */
export async function loadProfile(
  db: SupabaseClient,
  userId: string,
  email: string | null,
): Promise<CrmProfile | null> {
  const { data, error } = await db
    .from("memberships")
    .select("id, role, display_name, tenant_id, tenants(slug, name)")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1);

  if (error || !Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as unknown as MembershipRow;
  const tenant = toOne(row.tenants);
  if (!tenant) return null;

  return {
    userId,
    email,
    tenant: { id: row.tenant_id, slug: tenant.slug, name: tenant.name },
    membership: { id: row.id, role: row.role, displayName: row.display_name },
  };
}

/**
 * Resolves the session (refreshing once if the access token has expired)
 * and attaches { db, profile }. An unresolved session falls through with
 * nothing attached; requireSession decides what that means per route.
 */
export async function sessionMiddleware(c: AppContext, next: Next): Promise<Response | void> {
  const access = getCookie(c, ACCESS_COOKIE) ?? null;
  const refresh = getCookie(c, REFRESH_COOKIE) ?? null;

  if (access !== null) {
    const db = userClient(c.env, access);
    const { data, error } = await db.auth.getUser(access);
    if (!error && data.user) {
      const profile = await loadProfile(db, data.user.id, data.user.email ?? null);
      if (profile) {
        c.set("db", db);
        c.set("profile", profile);
        return next();
      }
      // Authenticated but no active membership (deactivated, or a session
      // that outlived its membership): not a session this app honours.
      clearSessionCookies(c);
      return next();
    }
  }

  if (refresh !== null) {
    const auth = anonClient(c.env);
    const { data, error } = await auth.auth.refreshSession({ refresh_token: refresh });
    if (!error && data.session && data.user) {
      const db = userClient(c.env, data.session.access_token);
      const profile = await loadProfile(db, data.user.id, data.user.email ?? null);
      if (profile) {
        setSessionCookies(c, data.session.access_token, data.session.refresh_token);
        c.set("db", db);
        c.set("profile", profile);
        return next();
      }
    }
    clearSessionCookies(c);
  }

  return next();
}

/**
 * Wayfinding for signed-out requests: send them to the login page and
 * remember where they were going. Never a data decision.
 */
export function requireSession(c: AppContext): AuthVars | Response {
  const db = c.get("db");
  const profile = c.get("profile");
  if (!db || !profile) {
    const url = new URL(c.req.url);
    const next = `${url.pathname}${url.search}`;
    const target = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
    return c.redirect(target, 302) as Response;
  }
  return { db, profile };
}

export const isResponse = (v: AuthVars | Response): v is Response => v instanceof Response;

/**
 * A same-origin check for state-changing posts. SameSite=Lax already keeps
 * cookies off cross-site POSTs; this is the belt to those suspenders.
 *
 * It depends on the browser sending a real Origin, which depends on the
 * referrer policy this app ships: under `Referrer-Policy: no-referrer` a
 * browser serializes the Origin of a form POST as the literal string
 * "null", and this check then refuses every genuine sign-in. That is not
 * theory — it happened here, in a real Chromium, against wrangler dev,
 * and no amount of test-suite Origin headers would have found it. The
 * policy is `same-origin` for exactly this reason (src/index.tsx).
 *
 * A missing Origin is allowed (some clients omit it on same-origin form
 * posts); a literal "null" is not, because a sandboxed iframe can produce
 * one on purpose.
 */
export function sameOrigin(c: AppContext): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}
