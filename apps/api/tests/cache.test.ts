import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/services/cache.js';

describe('LruCache', () => {
  it('evicts the least recently used entry when maxEntries is exceeded', () => {
    const cache = new LruCache<string>({ ttlMs: 1000, maxEntries: 2, maxBytes: 100 });
    cache.set('a', 'A', 1);
    cache.set('b', 'B', 1);
    cache.get('a'); // a becomes most recently used
    cache.set('c', 'C', 1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
  });

  it('evicts until total bytes fit within maxBytes', () => {
    const cache = new LruCache<string>({ ttlMs: 1000, maxEntries: 10, maxBytes: 10 });
    cache.set('a', 'A', 4);
    cache.set('b', 'B', 4);
    cache.set('c', 'C', 4);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.totalBytes).toBe(8);
  });

  it('refuses entries larger than the whole budget', () => {
    const cache = new LruCache<string>({ ttlMs: 1000, maxEntries: 10, maxBytes: 10 });
    cache.set('a', 'A', 4);
    cache.set('big', 'BIG', 11);
    expect(cache.get('big')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
  });

  it('expires entries by TTL and releases their bytes', () => {
    let now = 0;
    const cache = new LruCache<string>({
      ttlMs: 100,
      maxEntries: 10,
      maxBytes: 10,
      now: () => now,
    });
    cache.set('a', 'A', 5);
    now = 99;
    expect(cache.get('a')).toBe('A');
    now = 100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });

  it('accounts bytes correctly when a key is overwritten', () => {
    const cache = new LruCache<string>({ ttlMs: 100, maxEntries: 10, maxBytes: 10 });
    cache.set('a', 'A', 5);
    cache.set('a', 'A2', 3);
    expect(cache.totalBytes).toBe(3);
    expect(cache.size).toBe(1);
  });
});
