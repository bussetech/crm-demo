import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";

const options = { auth: { persistSession: false, autoRefreshToken: false } };

/**
 * A client that acts AS THE SIGNED-IN USER: every query carries their JWT,
 * so row-level security governs every read. This is the ONLY client that
 * ever answers a request for tenant data — authorization lives in the
 * database, not in route code.
 *
 * There is deliberately no service-role client in this module. The service
 * plane (seed, reset) runs in `scripts/`, never in a request path.
 */
export function userClient(env: Env, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...options,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** The signed-out client: sign-in and token refresh only. */
export function anonClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, options);
}

/**
 * PostgREST embeds a to-one relation as an object, but the JS client types
 * every embed as an array (stratum gotcha, eaap paid for it). Normalize
 * rather than cast.
 */
export const toOne = <T>(embedded: T | T[] | null | undefined): T | null => {
  if (embedded === null || embedded === undefined) return null;
  return Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
};
