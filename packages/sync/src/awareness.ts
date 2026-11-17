import { Emitter, freezeJson, type Json, type ReplicaId } from '@flock/crdt';
import type { AwarenessEntry } from './protocol.js';
import { realScheduler, type Scheduler, type TimerHandle } from './scheduler.js';

/** Entries to broadcast: emitted for local changes and for applied remote ones (to relay). */
export interface AwarenessUpdate {
  readonly entries: readonly AwarenessEntry[];
  readonly origin: unknown;
}

/** What changed in the set of visible peers. */
export interface AwarenessChange {
  readonly added: readonly ReplicaId[];
  readonly updated: readonly ReplicaId[];
  readonly removed: readonly ReplicaId[];
  readonly origin: unknown;
}

interface AwarenessEvents extends Record<string, unknown> {
  update: AwarenessUpdate;
  change: AwarenessChange;
}

export interface AwarenessOptions {
  readonly scheduler?: Scheduler;
  /** Peers silent for this long are dropped; the local state is renewed at half of it. */
  readonly timeoutMs?: number;
}

interface Known {
  clock: number;
  state: Json | null;
  lastSeen: number;
}

/**
 * Presence (who is here, their cursor and color). Not part of the document: each replica owns
 * one entry and overwrites it with an increasing clock; the highest clock wins everywhere.
 * Entries that stop being renewed time out, so crashed peers disappear on their own.
 */
export class Awareness {
  readonly replicaId: ReplicaId;
  readonly #scheduler: Scheduler;
  readonly #timeoutMs: number;
  readonly #known = new Map<ReplicaId, Known>();
  readonly #events = new Emitter<AwarenessEvents>();
  #timer: TimerHandle | null = null;
  #destroyed = false;

  constructor(replicaId: ReplicaId, options: AwarenessOptions = {}) {
    this.replicaId = replicaId;
    this.#scheduler = options.scheduler ?? realScheduler;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#schedule();
  }

  on<K extends keyof AwarenessEvents>(
    event: K,
    listener: (payload: AwarenessEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, listener);
  }

  getLocalState(): Json | null {
    return this.#known.get(this.replicaId)?.state ?? null;
  }

  setLocalState(state: Json | null): void {
    const previous = this.#known.get(this.replicaId);
    const clock = (previous?.clock ?? 0) + 1;
    const frozen = state === null ? null : freezeJson(state);
    this.#known.set(this.replicaId, { clock, state: frozen, lastSeen: this.#scheduler.now() });
    const had = previous !== undefined && previous.state !== null;
    this.#emitChange(
      frozen !== null && !had ? [this.replicaId] : [],
      frozen !== null && had ? [this.replicaId] : [],
      frozen === null && had ? [this.replicaId] : [],
      'local',
    );
    this.#events.emit('update', {
      entries: [{ replica: this.replicaId, clock, state: frozen }],
      origin: 'local',
    });
  }

  /** Sets one field of an object-shaped local state. */
  setLocalField(field: string, value: Json): void {
    const current = this.getLocalState();
    const isObject = current !== null && typeof current === 'object' && !Array.isArray(current);
    const base = isObject ? (current as { readonly [key: string]: Json }) : {};
    this.setLocalState({ ...base, [field]: value });
  }

  /** Visible states, including the local one. */
  getStates(): Map<ReplicaId, Json> {
    const out = new Map<ReplicaId, Json>();
    for (const [replica, known] of this.#known)
      if (known.state !== null) out.set(replica, known.state);
    return out;
  }

  /** Entries for every visible replica (sent to a peer that just connected), sorted by replica. */
  entries(): AwarenessEntry[] {
    return [...this.#known]
      .filter(([, k]) => k.state !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([replica, k]) => ({ replica, clock: k.clock, state: k.state }));
  }

  /** Applies entries from the network. Stale entries (lower or equal clock) are ignored. */
  applyEntries(entries: readonly AwarenessEntry[], origin: unknown): void {
    const added: ReplicaId[] = [];
    const updated: ReplicaId[] = [];
    const removed: ReplicaId[] = [];
    const relay: AwarenessEntry[] = [];
    const now = this.#scheduler.now();
    for (const entry of entries) {
      const known = this.#known.get(entry.replica);
      if (entry.replica === this.replicaId) {
        // Someone thinks we left (e.g. a server timed us out): re-assert with a higher clock.
        if (known && entry.clock >= known.clock && known.state !== null && entry.state === null) {
          known.clock = entry.clock;
          this.setLocalState(known.state);
        }
        continue;
      }
      if (known && entry.clock <= known.clock) continue;
      const state = entry.state === null ? null : freezeJson(entry.state);
      this.#known.set(entry.replica, { clock: entry.clock, state, lastSeen: now });
      relay.push({ replica: entry.replica, clock: entry.clock, state });
      const had = known !== undefined && known.state !== null;
      if (state !== null && !had) added.push(entry.replica);
      else if (state !== null) updated.push(entry.replica);
      else if (had) removed.push(entry.replica);
    }
    this.#emitChange(added, updated, removed, origin);
    if (relay.length > 0) this.#events.emit('update', { entries: relay, origin });
  }

  /**
   * Marks replicas as gone (for example when their connection closed) and broadcasts that with
   * a bumped clock so the removal wins on every peer.
   */
  removeStates(replicas: readonly ReplicaId[], origin: unknown): void {
    const entries: AwarenessEntry[] = [];
    const removed: ReplicaId[] = [];
    for (const replica of replicas) {
      if (replica === this.replicaId) continue;
      const known = this.#known.get(replica);
      if (!known || known.state === null) continue;
      known.clock++;
      known.state = null;
      entries.push({ replica, clock: known.clock, state: null });
      removed.push(replica);
    }
    this.#emitChange([], [], removed, origin);
    if (entries.length > 0) this.#events.emit('update', { entries, origin });
  }

  /** Stops timers and announces that this replica left. */
  destroy(): void {
    if (this.#destroyed) return;
    if (this.getLocalState() !== null) this.setLocalState(null);
    this.#destroyed = true;
    if (this.#timer) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #emitChange(
    added: ReplicaId[],
    updated: ReplicaId[],
    removed: ReplicaId[],
    origin: unknown,
  ): void {
    if (added.length + updated.length + removed.length === 0) return;
    this.#events.emit('change', { added, updated, removed, origin });
  }

  #schedule(): void {
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#check();
      if (!this.#destroyed) this.#schedule();
    }, this.#timeoutMs / 6);
  }

  #check(): void {
    const now = this.#scheduler.now();
    const local = this.#known.get(this.replicaId);
    if (local && local.state !== null && now - local.lastSeen >= this.#timeoutMs / 2) {
      this.setLocalState(local.state);
    }
    const removed: ReplicaId[] = [];
    for (const [replica, known] of this.#known) {
      if (replica === this.replicaId || known.state === null) continue;
      if (now - known.lastSeen >= this.#timeoutMs) {
        known.state = null;
        removed.push(replica);
      }
    }
    this.#emitChange([], [], removed, 'timeout');
  }
}
