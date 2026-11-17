import {
  Emitter,
  encodeUpdate,
  type Doc,
  type Op,
  type ReplicaId,
  type UpdateEvent,
} from '@flock/crdt';
import type { Awareness, AwarenessUpdate } from './awareness.js';
import { decodeMessage, encodeMessage, type Message } from './protocol.js';
import { realScheduler, type Scheduler, type TimerHandle } from './scheduler.js';

export interface SyncSessionOptions {
  /** Delivers an encoded message to the remote peer. */
  readonly send: (message: Uint8Array) => void;
  readonly awareness?: Awareness;
  readonly scheduler?: Scheduler;
  /** Interval of the periodic state-vector exchange that repairs lost messages (0 = off). */
  readonly antiEntropyMs?: number;
  /** Delay before asking for missing history after an update could not be applied. */
  readonly gapRetryMs?: number;
}

interface SessionEvents extends Record<string, unknown> {
  /** The remote peer answered our first state vector: we hold everything it had. */
  synced: undefined;
}

/**
 * Keeps one Doc (and optionally one Awareness) in sync with one remote peer over any
 * message transport. A peer with several links runs one session per link; because every
 * session forwards updates that did not come from its own link, edits also travel across
 * multi-hop topologies (the server relay, the Partition Lab mesh).
 *
 * Protocol: on connect both sides send `sync-step1` (state vector) and answer the other's with
 * `sync-step2` (what it lacks). Afterwards new operations are pushed as `update`. Edits made
 * while disconnected wait in an outbox and are flushed on reconnect. A periodic step 1
 * (anti-entropy) repairs anything lost in transit, and an update with missing dependencies
 * triggers an early step 1.
 */
export class SyncSession {
  readonly #doc: Doc;
  readonly #awareness: Awareness | undefined;
  readonly #send: (message: Uint8Array) => void;
  readonly #scheduler: Scheduler;
  readonly #antiEntropyMs: number;
  readonly #gapRetryMs: number;
  readonly #events = new Emitter<SessionEvents>();
  readonly #unsubscribe: Array<() => void> = [];
  readonly #remoteReplicas = new Set<ReplicaId>();
  #outbox: Op[] = [];
  #connected = false;
  #synced = false;
  #destroyed = false;
  #antiEntropyTimer: TimerHandle | null = null;
  #gapTimer: TimerHandle | null = null;
  #lastStep1 = Number.NEGATIVE_INFINITY;

  constructor(doc: Doc, options: SyncSessionOptions) {
    this.#doc = doc;
    this.#awareness = options.awareness;
    this.#send = options.send;
    this.#scheduler = options.scheduler ?? realScheduler;
    this.#antiEntropyMs = options.antiEntropyMs ?? 3000;
    this.#gapRetryMs = options.gapRetryMs ?? 50;
    this.#unsubscribe.push(
      doc.on('update', (e) => {
        this.#onDocUpdate(e);
      }),
    );
    if (this.#awareness) {
      this.#unsubscribe.push(
        this.#awareness.on('update', (u) => {
          this.#onAwarenessUpdate(u);
        }),
      );
    }
  }

  on<K extends keyof SessionEvents>(
    event: K,
    listener: (payload: SessionEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, listener);
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** True after the remote peer answered our first step 1 of the current connection. */
  get synced(): boolean {
    return this.#synced;
  }

  /** Operations waiting to be sent when the link comes back. */
  get outboxSize(): number {
    return this.#outbox.length;
  }

  /** Replicas whose presence arrived over this session (the server removes them on close). */
  get remoteReplicas(): ReadonlySet<ReplicaId> {
    return this.#remoteReplicas;
  }

  /** The link is up: exchange state vectors, flush the outbox and share presence. */
  connect(): void {
    if (this.#connected || this.#destroyed) return;
    this.#connected = true;
    this.#synced = false;
    this.#sendStep1();
    if (this.#outbox.length > 0) {
      const ops = this.#outbox;
      this.#outbox = [];
      this.#post({ type: 'update', update: encodeUpdate(ops) });
    }
    const entries = this.#awareness?.entries() ?? [];
    if (entries.length > 0) this.#post({ type: 'awareness', entries });
    this.#scheduleAntiEntropy();
  }

  /** The link is down: stop sending; local edits go to the outbox. */
  disconnect(): void {
    this.#connected = false;
    this.#synced = false;
    this.#clearTimers();
  }

  /** Handles one message from the remote peer. Throws DecodeError / InvalidOpError on bad input. */
  receive(bytes: Uint8Array): void {
    if (this.#destroyed) return;
    const msg = decodeMessage(bytes);
    switch (msg.type) {
      case 'sync-step1': {
        this.#post({ type: 'sync-step2', update: this.#doc.encodeStateAsUpdate(msg.stateVector) });
        const relation = msg.stateVector.compare(this.#doc.stateVector());
        if (relation === 'after' || relation === 'concurrent') this.#requestSoon(0);
        break;
      }
      case 'sync-step2':
        this.#doc.applyUpdate(msg.update, this);
        if (!this.#synced && this.#connected) {
          this.#synced = true;
          this.#events.emit('synced', undefined);
        }
        this.#checkGaps();
        break;
      case 'update':
        this.#doc.applyUpdate(msg.update, this);
        this.#checkGaps();
        break;
      case 'awareness':
        for (const entry of msg.entries) {
          if (entry.state === null) this.#remoteReplicas.delete(entry.replica);
          else this.#remoteReplicas.add(entry.replica);
        }
        this.#awareness?.applyEntries(msg.entries, this);
        break;
    }
  }

  destroy(): void {
    this.disconnect();
    this.#destroyed = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#outbox = [];
  }

  #post(msg: Message): void {
    if (this.#connected) this.#send(encodeMessage(msg));
  }

  #sendStep1(): void {
    this.#lastStep1 = this.#scheduler.now();
    this.#post({ type: 'sync-step1', stateVector: this.#doc.stateVector() });
  }

  #onDocUpdate(event: UpdateEvent): void {
    if (event.origin === this || this.#destroyed) return;
    if (this.#connected) this.#post({ type: 'update', update: event.update });
    else this.#outbox.push(...event.ops);
  }

  #onAwarenessUpdate(update: AwarenessUpdate): void {
    if (update.origin === this) return;
    this.#post({ type: 'awareness', entries: update.entries });
  }

  /** Buffered operations mean something was lost or reordered: ask the peer for it. */
  #checkGaps(): void {
    if (this.#doc.pendingCount > 0) this.#requestSoon(this.#gapRetryMs);
  }

  #requestSoon(delay: number): void {
    if (!this.#connected || this.#gapTimer) return;
    if (delay === 0 && this.#scheduler.now() - this.#lastStep1 < this.#gapRetryMs) return;
    this.#gapTimer = this.#scheduler.setTimeout(() => {
      this.#gapTimer = null;
      if (this.#connected) this.#sendStep1();
    }, delay);
  }

  #scheduleAntiEntropy(): void {
    if (this.#antiEntropyMs <= 0) return;
    this.#antiEntropyTimer = this.#scheduler.setTimeout(() => {
      this.#antiEntropyTimer = null;
      if (!this.#connected) return;
      this.#sendStep1();
      this.#scheduleAntiEntropy();
    }, this.#antiEntropyMs);
  }

  #clearTimers(): void {
    if (this.#antiEntropyTimer) this.#scheduler.clearTimeout(this.#antiEntropyTimer);
    if (this.#gapTimer) this.#scheduler.clearTimeout(this.#gapTimer);
    this.#antiEntropyTimer = null;
    this.#gapTimer = null;
  }
}
