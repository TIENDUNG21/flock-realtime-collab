import { LamportClock } from './clock/lamport.js';
import { VectorClock } from './clock/vector.js';
import { Emitter } from './emitter.js';
import { InvalidOpError } from './errors.js';
import { isValidReplicaId, randomReplicaId, type Id, type ReplicaId } from './id.js';
import type { Json } from './json.js';
import { LwwMap } from './lww-map.js';
import {
  MAX_TARGET_LENGTH,
  opLength,
  typeKindOf,
  validateOp,
  type Op,
  type TypeKind,
} from './ops.js';
import { Rga } from './text/rga.js';
import { MapType } from './types/map.js';
import { TextType, type LocalOpSink } from './types/text.js';

/** Origin used for transactions made through the local API. */
export const LOCAL_ORIGIN = 'local';

/** Emitted once per transaction or applied batch with the operations that became part of the doc. */
export interface UpdateEvent {
  readonly ops: readonly Op[];
  /** `'local'` (or the value given to `transact`) for local edits; the caller's origin for remote ones. */
  readonly origin: unknown;
  readonly local: boolean;
}

/** Emitted after an update with the names of the shared types that changed. */
export interface ChangeEvent {
  readonly targets: ReadonlySet<string>;
  readonly origin: unknown;
  readonly local: boolean;
}

export interface DocEvents extends Record<string, unknown> {
  update: UpdateEvent;
  change: ChangeEvent;
}

export interface DocOptions {
  /** Unique id of this replica. Never reuse an id for two independent copies of history. */
  readonly replicaId?: ReplicaId;
}

type SharedType =
  | { readonly kind: 'text'; readonly rga: Rga; readonly api: TextType }
  | { readonly kind: 'map'; readonly entries: LwwMap<Json>; readonly api: MapType };

interface Batch {
  readonly ops: Op[];
  readonly targets: Set<string>;
  readonly origin: unknown;
  readonly local: boolean;
}

/** Index of the first op in `log` (sorted by seq) whose last unit is after `seq`. */
function firstAfter(log: readonly Op[], seq: number): number {
  let lo = 0;
  let hi = log.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const op = log[mid];
    if (op && op.id.seq + opLength(op) - 1 <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A replicated document: a set of named shared types (texts and maps) plus the history that
 * built them. Every operation has a unique id `(replica, seq)`; the state vector records how many
 * ids of each replica are integrated. Operations from other replicas are applied in causal order:
 * an operation waits in a buffer until the operations it depends on have been applied.
 */
export class Doc implements LocalOpSink {
  readonly replicaId: ReplicaId;
  readonly #clock = new LamportClock();
  readonly #sv = new VectorClock();
  readonly #log = new Map<ReplicaId, Op[]>();
  readonly #pending = new Map<ReplicaId, Map<number, Op>>();
  readonly #types = new Map<string, SharedType>();
  /** Kind each name is bound to, including names only referenced by buffered operations. */
  readonly #kinds = new Map<string, TypeKind>();
  readonly #events = new Emitter<DocEvents>();
  #batch: Batch | null = null;

  constructor(options: DocOptions = {}) {
    const replicaId = options.replicaId ?? randomReplicaId();
    if (!isValidReplicaId(replicaId)) {
      throw new TypeError('replicaId must be a non-empty string of at most 64 characters');
    }
    this.replicaId = replicaId;
  }

  on<K extends keyof DocEvents>(event: K, listener: (payload: DocEvents[K]) => void): () => void {
    return this.#events.on(event, listener);
  }

  getText(name: string): TextType {
    const type = this.#type(name, 'text');
    if (type.kind !== 'text') throw new TypeError(`"${name}" is a map, not a text`);
    return type.api;
  }

  getMap(name: string): MapType {
    const type = this.#type(name, 'map');
    if (type.kind !== 'map') throw new TypeError(`"${name}" is a text, not a map`);
    return type.api;
  }

  /** Names of the shared types that exist in this document, sorted. */
  typeNames(): string[] {
    return [...this.#types.keys()].sort();
  }

  /** Copy of the state vector: replica -> number of integrated ids. */
  stateVector(): VectorClock {
    return this.#sv.clone();
  }

  /** Number of operations waiting for causal dependencies. */
  get pendingCount(): number {
    let count = 0;
    for (const byReplica of this.#pending.values()) count += byReplica.size;
    return count;
  }

  /** What buffered operations are waiting for: replica -> highest id needed. */
  missing(): VectorClock {
    const need = new VectorClock();
    const want = (replica: ReplicaId, seq: number): void => {
      if (seq > this.#sv.get(replica) && seq > need.get(replica)) need.set(replica, seq);
    };
    for (const [replica, byReplica] of this.#pending) {
      for (const op of byReplica.values()) {
        want(replica, op.id.seq - 1);
        if (op.kind === 'ins' && op.origin) want(op.origin.replica, op.origin.seq);
        if (op.kind === 'del') for (const r of op.ranges) want(r.replica, r.seq + r.len - 1);
      }
    }
    return need;
  }

  /** Operations not covered by `since` (everything by default), grouped by replica in id order. */
  opsSince(since: VectorClock = new VectorClock()): Op[] {
    const out: Op[] = [];
    const replicas = [...this.#log.keys()].sort();
    for (const replica of replicas) {
      const log = this.#log.get(replica) ?? [];
      for (let i = firstAfter(log, since.get(replica)); i < log.length; i++) {
        const op = log[i];
        if (op) out.push(op);
      }
    }
    return out;
  }

  /**
   * Runs `fn` and publishes the local operations it creates as one update. Nested calls join the
   * outer transaction.
   */
  transact(fn: () => void, origin: unknown = LOCAL_ORIGIN): void {
    if (this.#batch) {
      fn();
      return;
    }
    const batch: Batch = { ops: [], targets: new Set(), origin, local: true };
    this.#batch = batch;
    try {
      fn();
    } finally {
      this.#batch = null;
      this.#publish(batch);
    }
  }

  /** @internal Used by shared types to create local operations. */
  local(length: number, build: (id: Id, lamport: number) => Op): void {
    if (!this.#batch) {
      this.transact(() => {
        this.local(length, build);
      });
      return;
    }
    if (!this.#batch.local) throw new Error('cannot edit locally while applying remote operations');
    const id = { replica: this.replicaId, seq: this.#sv.get(this.replicaId) + 1 };
    const op = build(id, this.#clock.tick(length));
    this.#integrate(op, this.#batch);
  }

  /**
   * Applies operations received from other replicas. Duplicates are ignored, operations whose
   * dependencies are missing are buffered, and the whole batch is rejected with InvalidOpError
   * (before anything is applied) when an operation is malformed.
   */
  applyOps(input: readonly Op[], origin: unknown = null): void {
    if (this.#batch) throw new Error('cannot apply remote operations inside a transaction');
    const ops = input.map((op) => validateOp(op));
    const kinds = new Map<string, TypeKind>();
    for (const op of ops) {
      const kind = typeKindOf(op);
      const bound = this.#kinds.get(op.target) ?? kinds.get(op.target);
      if (bound && bound !== kind) {
        throw new InvalidOpError(
          `operation ${op.kind} targets "${op.target}", which is a ${bound}`,
        );
      }
      kinds.set(op.target, kind);
      const known = this.#sv.get(op.id.replica);
      if (op.id.seq <= known && op.id.seq + opLength(op) - 1 > known) {
        throw new InvalidOpError(`operation ${op.id.replica}@${op.id.seq} overlaps known history`);
      }
    }

    const batch: Batch = { ops: [], targets: new Set(), origin, local: false };
    this.#batch = batch;
    try {
      for (const op of ops) {
        const replica = op.id.replica;
        if (op.id.seq <= this.#sv.get(replica)) continue;
        let byReplica = this.#pending.get(replica);
        if (!byReplica) {
          byReplica = new Map();
          this.#pending.set(replica, byReplica);
        }
        if (!byReplica.has(op.id.seq)) {
          byReplica.set(op.id.seq, op);
          this.#kinds.set(op.target, typeKindOf(op));
        }
      }
      this.#drain(batch);
    } finally {
      this.#batch = null;
    }
    this.#publish(batch);
  }

  /** Canonical view of the full state, for tests and debugging. Equal on converged replicas. */
  debugState(): Record<string, unknown> {
    const types: Record<string, unknown> = {};
    for (const name of this.typeNames()) {
      const type = this.#types.get(name);
      if (type?.kind === 'text') {
        types[name] = {
          kind: 'text',
          text: type.rga.toString(),
          items: Array.from(
            type.rga.items(),
            (it) => `${it.replica}@${it.seq}${it.deleted ? '-' : ''}`,
          ),
        };
      } else if (type) {
        types[name] = { kind: 'map', value: type.entries.toObject() };
      }
    }
    return { stateVector: this.#sv.toJSON(), pending: this.pendingCount, types };
  }

  #type(name: string, kind: TypeKind): SharedType {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TARGET_LENGTH) {
      throw new TypeError(`type names must be 1 to ${MAX_TARGET_LENGTH} characters`);
    }
    const existing = this.#types.get(name);
    if (existing) return existing;
    const bound = this.#kinds.get(name) ?? kind;
    let type: SharedType;
    if (bound === 'text') {
      const rga = new Rga();
      type = { kind: 'text', rga, api: new TextType(name, this, rga) };
    } else {
      const entries = new LwwMap<Json>();
      type = { kind: 'map', entries, api: new MapType(name, this, entries) };
    }
    this.#types.set(name, type);
    this.#kinds.set(name, bound);
    return type;
  }

  #ready(op: Op): boolean {
    if (op.id.seq !== this.#sv.get(op.id.replica) + 1) return false;
    if (op.kind === 'ins') return op.origin === null || this.#sv.covers(op.origin);
    if (op.kind === 'del') {
      return op.ranges.every((r) => this.#sv.get(r.replica) >= r.seq + r.len - 1);
    }
    return true;
  }

  #drain(batch: Batch): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const [replica, byReplica] of this.#pending) {
        let op = byReplica.get(this.#sv.get(replica) + 1);
        while (op && this.#ready(op)) {
          byReplica.delete(op.id.seq);
          this.#integrate(op, batch);
          progress = true;
          op = byReplica.get(this.#sv.get(replica) + 1);
        }
        const known = this.#sv.get(replica);
        for (const seq of byReplica.keys()) if (seq <= known) byReplica.delete(seq);
        if (byReplica.size === 0) this.#pending.delete(replica);
      }
    }
  }

  #integrate(op: Op, batch: Batch): void {
    const type = this.#type(op.target, typeKindOf(op));
    if (op.kind === 'ins' && type.kind === 'text') type.rga.integrateInsert(op);
    else if (op.kind === 'del' && type.kind === 'text') type.rga.integrateDelete(op);
    else if (op.kind === 'set' && type.kind === 'map')
      type.entries.apply(op.key, op.value, { lamport: op.lamport, replica: op.id.replica });
    const length = opLength(op);
    this.#clock.observe(op.lamport + length - 1);
    this.#sv.set(op.id.replica, op.id.seq + length - 1);
    let log = this.#log.get(op.id.replica);
    if (!log) {
      log = [];
      this.#log.set(op.id.replica, log);
    }
    log.push(op);
    batch.ops.push(op);
    batch.targets.add(op.target);
  }

  #publish(batch: Batch): void {
    if (batch.ops.length === 0) return;
    const { ops, origin, local, targets } = batch;
    this.#events.emit('update', { ops, origin, local });
    this.#events.emit('change', { targets, origin, local });
  }
}
