import type { Id, ReplicaId } from '../id.js';

/** Causal relation between two vector clocks. */
export type Ordering = 'before' | 'after' | 'equal' | 'concurrent';

function checkCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`vector clock entries must be non-negative integers, got ${value}`);
  }
}

/**
 * A vector clock: replica -> number of history units seen from that replica.
 * Used as the document "state vector": because sequence numbers are consecutive per replica,
 * entry `r -> n` means "I hold every unit `(r, 1..n)`". Missing entries read as zero.
 */
export class VectorClock {
  readonly #entries = new Map<ReplicaId, number>();

  static from(
    source: Iterable<readonly [ReplicaId, number]> | Record<ReplicaId, number>,
  ): VectorClock {
    const clock = new VectorClock();
    const pairs = Symbol.iterator in source ? source : Object.entries(source);
    for (const [replica, value] of pairs) clock.set(replica, value);
    return clock;
  }

  get(replica: ReplicaId): number {
    return this.#entries.get(replica) ?? 0;
  }

  set(replica: ReplicaId, value: number): void {
    checkCount(value);
    if (value === 0) this.#entries.delete(replica);
    else this.#entries.set(replica, value);
  }

  /** Increments the entry for `replica` and returns the new value. */
  increment(replica: ReplicaId): number {
    const next = this.get(replica) + 1;
    this.#entries.set(replica, next);
    return next;
  }

  /** Number of replicas with a non-zero entry. */
  get size(): number {
    return this.#entries.size;
  }

  /** True when the history unit `id` is included in this clock. */
  covers(id: Id): boolean {
    return this.get(id.replica) >= id.seq;
  }

  /** Pointwise maximum, as a new clock. */
  merge(other: VectorClock): VectorClock {
    const out = this.clone();
    for (const [replica, value] of other.#entries) {
      if (value > out.get(replica)) out.#entries.set(replica, value);
    }
    return out;
  }

  compare(other: VectorClock): Ordering {
    let less = false;
    let greater = false;
    const replicas = new Set([...this.#entries.keys(), ...other.#entries.keys()]);
    for (const replica of replicas) {
      const a = this.get(replica);
      const b = other.get(replica);
      if (a < b) less = true;
      else if (a > b) greater = true;
      if (less && greater) return 'concurrent';
    }
    if (less) return 'before';
    if (greater) return 'after';
    return 'equal';
  }

  equals(other: VectorClock): boolean {
    return this.compare(other) === 'equal';
  }

  clone(): VectorClock {
    const out = new VectorClock();
    for (const [replica, value] of this.#entries) out.#entries.set(replica, value);
    return out;
  }

  /** Non-zero entries sorted by replica id (deterministic for encoding and display). */
  entries(): Array<[ReplicaId, number]> {
    return [...this.#entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  toJSON(): Record<ReplicaId, number> {
    return Object.fromEntries(this.entries());
  }
}
