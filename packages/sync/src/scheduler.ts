/** Opaque handle returned by `Scheduler.setTimeout`. */
export interface TimerHandle {
  readonly id: number;
}

/** Time source and timers. Injected so tests and the simulator can run on virtual time. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The timer functions every JavaScript host provides (browsers, Node, workers). */
interface HostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const host = globalThis as unknown as HostTimers;
const nativeHandles = new Map<number, unknown>();
let nextRealId = 1;

/** Scheduler backed by the platform clock and timers. */
export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const id = nextRealId++;
    nativeHandles.set(
      id,
      host.setTimeout(() => {
        nativeHandles.delete(id);
        fn();
      }, ms),
    );
    return { id };
  },
  clearTimeout(handle) {
    const native = nativeHandles.get(handle.id);
    if (native !== undefined) {
      host.clearTimeout(native);
      nativeHandles.delete(handle.id);
    }
  },
};

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

const before = (a: Timer, b: Timer): boolean => a.at < b.at || (a.at === b.at && a.id < b.id);

/**
 * Deterministic scheduler on virtual time. Timers run in (due time, creation order) order when
 * `advance` moves the clock past them. Backed by a binary heap with lazy cancellation.
 */
export class VirtualScheduler implements Scheduler {
  #now = 0;
  #nextId = 1;
  readonly #heap: Timer[] = [];
  readonly #live = new Set<number>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer: Timer = { id: this.#nextId++, at: this.#now + Math.max(0, ms), fn };
    this.#live.add(timer.id);
    this.#push(timer);
    return { id: timer.id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.#live.delete(handle.id);
  }

  /** Number of timers waiting to run. */
  get pending(): number {
    return this.#live.size;
  }

  /** Moves time forward by `ms`, running every timer that becomes due, in order. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const top = this.#heap[0];
      if (!top || top.at > end) break;
      this.#pop();
      if (!this.#live.delete(top.id)) continue;
      this.#now = top.at;
      top.fn();
    }
    this.#now = end;
  }

  #push(timer: Timer): void {
    const heap = this.#heap;
    heap.push(timer);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent];
      if (!p || !before(timer, p)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = timer;
  }

  #pop(): void {
    const heap = this.#heap;
    const last = heap.pop();
    if (!last || heap.length === 0) return;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = last;
      let at = -1;
      const left = heap[l];
      const right = heap[r];
      if (left && before(left, smallest)) {
        smallest = left;
        at = l;
      }
      if (right && before(right, smallest)) {
        smallest = right;
        at = r;
      }
      if (at < 0) break;
      heap[i] = smallest;
      i = at;
    }
    heap[i] = last;
  }
}
