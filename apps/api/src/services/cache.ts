export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  size: number;
  expiresAt: number;
}

/**
 * Small LRU cache bounded by entry count *and* total bytes, with per-entry TTL.
 * A Map preserves insertion order, so re-inserting on read keeps the most
 * recently used entries at the end and the eviction candidate at the front.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private bytes = 0;
  private readonly now: () => number;

  constructor(private readonly options: CacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, size: number): void {
    if (size > this.options.maxBytes) return; // never cache something that would evict everything
    this.delete(key);
    this.entries.set(key, { value, size, expiresAt: this.now() + this.options.ttlMs });
    this.bytes += size;

    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.size;
    this.entries.delete(key);
  }
}
