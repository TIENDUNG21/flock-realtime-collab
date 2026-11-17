import { compareStamps, type Stamp } from './id.js';

interface Entry<V> {
  /** `undefined` marks a tombstone (the key was deleted). */
  value: V | undefined;
  stamp: Stamp;
}

/**
 * Last-writer-wins register map. Each key keeps the write with the greatest stamp, so the
 * result is independent of delivery order (commutative) and of duplicates (idempotent).
 * Deletions are tombstones: they keep their stamp so an older concurrent set cannot revive the key.
 */
export class LwwMap<V> {
  readonly #entries = new Map<string, Entry<V>>();
  #live = 0;

  /**
   * Applies a write. Returns true when it won (the visible state for `key` may have changed).
   * A write whose stamp is lower than or equal to the current one is ignored.
   */
  apply(key: string, value: V | undefined, stamp: Stamp): boolean {
    const current = this.#entries.get(key);
    if (current && compareStamps(stamp, current.stamp) <= 0) return false;
    if (current?.value !== undefined) this.#live--;
    if (value !== undefined) this.#live++;
    this.#entries.set(key, { value, stamp });
    return true;
  }

  get(key: string): V | undefined {
    return this.#entries.get(key)?.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** The stamp of the winning write for `key`, including tombstones. */
  stampOf(key: string): Stamp | undefined {
    return this.#entries.get(key)?.stamp;
  }

  /** Number of live (non-deleted) keys. */
  get size(): number {
    return this.#live;
  }

  /** Live keys in sorted order. */
  keys(): string[] {
    const keys: string[] = [];
    for (const [key, entry] of this.#entries) if (entry.value !== undefined) keys.push(key);
    return keys.sort();
  }

  /** Live entries in key order. */
  *entries(): IterableIterator<[string, V]> {
    for (const key of this.keys()) {
      const value = this.#entries.get(key)?.value;
      if (value !== undefined) yield [key, value];
    }
  }

  toObject(): Record<string, V> {
    return Object.fromEntries(this.entries());
  }
}
