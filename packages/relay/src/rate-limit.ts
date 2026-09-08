// In-memory sliding-window rate limiter (no dependencies).
//
// Buckets are pruned lazily: an entry is touched on check and swept when a
// bucket is accessed after its window has passed. Memory is bounded by the
// number of distinct keys seen within one window (~minutes).

const buckets = new Map<string, number[]>(); // key → timestamps (ms)

/** Record one event and return true if it's within `limit` per `windowMs`. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) {
    arr = [];
    buckets.set(key, arr);
  }
  // Drop timestamps outside the window.
  while (arr.length > 0 && now - arr[0] >= windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}

/** Number of distinct tracked keys (for metrics/tests). */
export function trackedKeys(): number {
  return buckets.size;
}

/** Drop everything (used by tests). */
export function resetLimiter(): void {
  buckets.clear();
}

/** Periodic sweep to keep memory flat with churny key spaces (per-IP auth). */
export function startSweep(intervalMs = 300_000): void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, arr] of buckets) {
      // Keep an empty array if the key was touched recently; delete otherwise.
      const last = arr[arr.length - 1] ?? 0;
      if (now - last >= intervalMs) buckets.delete(key);
    }
  }, intervalMs);
  timer.unref();
}
