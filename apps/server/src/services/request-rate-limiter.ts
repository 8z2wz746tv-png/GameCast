type RateBucket = {
  count: number;
  resetAt: number;
};

export class RequestRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number } {
    this.prune(now);
    const current = this.buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    if (this.buckets.size < 256) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
