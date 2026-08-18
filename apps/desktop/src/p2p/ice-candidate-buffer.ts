export class IceCandidateBuffer<T> {
  private readonly entries = new Map<string, { values: T[]; expiresAt: number }>();

  constructor(
    private readonly maxConnections = 32,
    private readonly maxCandidatesPerConnection = 64,
    private readonly ttlMs = 30_000,
  ) {}

  push(connectionId: string, candidate: T, now = Date.now()): void {
    this.prune(now);
    let entry = this.entries.get(connectionId);
    if (!entry) {
      while (this.entries.size >= this.maxConnections) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (!oldest) break;
        this.entries.delete(oldest);
      }
      entry = { values: [], expiresAt: now + this.ttlMs };
      this.entries.set(connectionId, entry);
    }
    entry.expiresAt = now + this.ttlMs;
    if (entry.values.length < this.maxCandidatesPerConnection) entry.values.push(candidate);
  }

  take(connectionId: string, now = Date.now()): T[] {
    this.prune(now);
    const values = this.entries.get(connectionId)?.values ?? [];
    this.entries.delete(connectionId);
    return values;
  }

  delete(connectionId: string): void {
    this.entries.delete(connectionId);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [connectionId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(connectionId);
    }
  }
}
