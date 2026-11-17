/** Seeded pseudo-random generator (mulberry32): fast, 32-bit state, reproducible. */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new RangeError('cannot pick from an empty list');
    return item;
  }
}
