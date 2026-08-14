// The Worker's binding surface and the session-shaped types that ride it.
// Nothing here is a secret: SUPABASE_ANON_KEY is public by design because
// RLS — not this app — is the authorization boundary (stratum law).

import type { MemberRole } from "./domain/roles";

export interface Env {
  SUPABASE_URL: string;
  /** public by design — RLS is the authorization boundary */
  SUPABASE_ANON_KEY: string;
  APP_BUILD_ID: string;
}

/**
 * Who the request is, resolved through the user's OWN JWT. The tenant is
 * read from the database (the user's active membership), never from
 * anything the request carries — that is what makes tenant scoping
 * structural rather than a route-parameter check.
 *
 * v1 binds a session to exactly one tenant: the seeded demo accounts hold
 * exactly one membership each. A user with several would need a tenant
 * switcher; that is a build, not a guess, so this resolves the first
 * active membership and the app says nothing about switching.
 */
export interface CrmProfile {
  userId: string;
  email: string | null;
  tenant: { id: string; slug: string; name: string };
  membership: { id: string; role: MemberRole; displayName: string };
}
