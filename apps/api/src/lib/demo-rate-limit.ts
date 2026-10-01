/**
 * A tiny in-memory, per-IP rate limiter for the demo guard's job-triggering
 * routes ("Back up now", "Verify now", requesting a restore — security
 * review finding 3). The IP is read here only to key this limiter; it is
 * never written to the database, never logged, and never reaches
 * lib/request.ts `clientIp`/`clientIpOf`, which stay null in demo mode
 * (finding 2). The counters live only in process memory and reset with every
 * restart — fully in keeping with a nightly-reset demo.
 */

export interface RateLimitWindow {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of distinct spoofed IPs cannot grow it forever. */
const MAX_TRACKED_KEYS = 10_000;

/** True when `key` has already used up its budget for the current window. */
export function demoRateLimitExceeded(
  key: string,
  window: RateLimitWindow,
  now: number = Date.now(),
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      buckets.clear();
    }
    buckets.set(key, { count: 1, resetAt: now + window.windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > window.max;
}

/** Clear every counter; tests only. */
export function resetDemoRateLimitsForTests(): void {
  buckets.clear();
}

/**
 * The IP this limiter keys on: the first `X-Forwarded-For` hop, or
 * `X-Real-IP`, or a constant fallback so requests with neither header still
 * share one bucket instead of bypassing the limit entirely. Deliberately
 * separate from lib/request.ts `clientIpOf` (which is null in demo mode) —
 * this value is used for nothing but the in-memory key above.
 */
export function rateLimitKeyOf(header: (name: string) => string | undefined): string {
  const forwarded = header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded;
  }
  const real = header("x-real-ip")?.trim();
  return real && real.length > 0 ? real : "unknown";
}
