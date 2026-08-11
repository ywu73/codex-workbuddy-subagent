import { realpath, stat } from "node:fs/promises";

interface CacheEntry<T> {
  key: string;
  expiresAt: number;
  value: Promise<T>;
}

export class CapabilityCache<T> {
  private entry: CacheEntry<T> | undefined;
  private hitCount = 0;
  private missCount = 0;

  constructor(readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  async get(executable: string, load: (realExecutable: string) => Promise<T>): Promise<T> {
    const resolved = await realpath(executable);
    const info = await stat(resolved);
    const key = `${resolved}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    if (this.entry?.key === key && this.entry.expiresAt > this.now()) {
      this.hitCount += 1;
      return await this.entry.value;
    }
    this.missCount += 1;
    const value = load(resolved);
    const entry = { key, expiresAt: this.now() + this.ttlMs, value };
    this.entry = entry;
    try {
      return await value;
    } catch (error) {
      if (this.entry === entry) this.entry = undefined;
      throw error;
    }
  }

  stats(): { ttl_ms: number; hits: number; misses: number; populated: boolean } {
    return { ttl_ms: this.ttlMs, hits: this.hitCount, misses: this.missCount, populated: this.entry !== undefined };
  }
}
