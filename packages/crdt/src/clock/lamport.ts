/**
 * A Lamport logical clock. Every locally created unit of history takes a fresh time;
 * every received unit is observed so that later local times are greater than anything seen.
 * This guarantees: if A causally precedes B then lamport(A) < lamport(B).
 */
export class LamportClock {
  #time: number;

  constructor(start = 0) {
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new RangeError(`Lamport start time must be a non-negative integer, got ${start}`);
    }
    this.#time = start;
  }

  /** The highest time issued or observed so far. */
  get now(): number {
    return this.#time;
  }

  /** Reserves `count` consecutive times and returns the first one. */
  tick(count = 1): number {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError(`tick count must be a positive integer, got ${count}`);
    }
    const first = this.#time + 1;
    this.#time += count;
    return first;
  }

  /** Moves the clock forward to at least `time`. */
  observe(time: number): void {
    if (time > this.#time) this.#time = time;
  }
}
