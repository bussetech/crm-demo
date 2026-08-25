// Basic rate limiting — the v1 containment floor (track law 3; ADR-0055
// §3 names "rate limits + body caps + no uploads" as the demo posture).
//
// HONEST SCOPE: this is a fixed-window counter in ISOLATE MEMORY. It is
// best-effort by construction — each Worker isolate counts alone, and a
// recycled isolate forgets. That is the right floor for this demo (what a
// limiter protects here is the origin's own cost and availability — the
// credentials are published on purpose, crm-demo#14), and it is NOT the
// ceiling: #14 keeps the go-live decision open for Cloudflare's native
// rate-limiting binding, a provisioning-time act with a cost fact
// attached (CRMDEMO-EPIC1-07).
//
// KEYING: the caller is named by `CF-Connecting-IP`, a header Cloudflare's
// edge sets and a client cannot spoof THROUGH that edge. When no edge has
// named the caller (unit tests, `wrangler dev`, a detached deployment)
// there is no honest key to count against, so the limiter stands aside —
// counting every anonymous caller as one shared bucket would rate-limit
// the test suite and nobody else.

export interface RateWindow {
  /** requests allowed per window per key */
  limit: number;
  windowMs: number;
}

/** Sign-in attempts: brute force is the (contained) concern. */
export const LOGIN_RATE: RateWindow = { limit: 10, windowMs: 60_000 };

/** Everything else that mutates: cost and defacement-churn containment. */
export const WRITE_RATE: RateWindow = { limit: 60, windowMs: 60_000 };

type Bucket = { windowStart: number; count: number };

/** Entries are pruned when the map grows past this — memory is bounded. */
const MAX_TRACKED_KEYS = 10_000;

export interface Limiter {
  /** true = allowed; false = over the limit for this window */
  take(key: string, now: number): boolean;
  /** seconds until this key's window resets — the Retry-After value */
  retryAfterSeconds(key: string, now: number): number;
}

export function createLimiter(window: RateWindow): Limiter {
  const buckets = new Map<string, Bucket>();

  const prune = (now: number): void => {
    if (buckets.size <= MAX_TRACKED_KEYS) return;
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= window.windowMs) buckets.delete(key);
    }
  };

  return {
    take(key, now) {
      prune(now);
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStart >= window.windowMs) {
        buckets.set(key, { windowStart: now, count: 1 });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= window.limit;
    },
    retryAfterSeconds(key, now) {
      const bucket = buckets.get(key);
      if (!bucket) return 0;
      const remaining = bucket.windowStart + window.windowMs - now;
      return Math.max(1, Math.ceil(remaining / 1000));
    },
  };
}

/**
 * The caller's name, if the edge gave it one. Null means "unnamed" and the
 * limiter stands aside (see the header comment for why that is the honest
 * behaviour rather than a hole: without the edge there is no key a client
 * did not choose for itself).
 */
export const callerKey = (headers: Headers): string | null =>
  headers.get("cf-connecting-ip");
