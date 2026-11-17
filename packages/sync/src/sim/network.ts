import { Doc, Emitter } from '@flock/crdt';
import { Awareness } from '../awareness.js';
import { describeMessage } from '../protocol.js';
import type { Scheduler } from '../scheduler.js';
import { SyncSession } from '../session.js';
import { Rng } from './rng.js';

/** Behaviour of a (bidirectional) simulated link. */
export interface LinkConfig {
  /** False = partitioned: nothing is sent and in-flight messages are lost. */
  readonly up: boolean;
  readonly latencyMs: number;
  /** Extra random delay in [0, jitterMs): makes messages overtake each other. */
  readonly jitterMs: number;
  /** Probability that a message is lost. */
  readonly loss: number;
  /** Probability that a message is delivered twice. */
  readonly duplicate: number;
}

export const DEFAULT_LINK: LinkConfig = {
  up: true,
  latencyMs: 40,
  jitterMs: 20,
  loss: 0,
  duplicate: 0,
};

interface MessageInfo {
  readonly time: number;
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly size: number;
  readonly summary: string;
}

export type NetworkEvent =
  | ({ readonly type: 'send' | 'deliver' | 'duplicate' } & MessageInfo)
  | ({ readonly type: 'drop'; readonly reason: 'loss' | 'partition' } & MessageInfo)
  | ({ readonly type: 'error'; readonly message: string } & MessageInfo)
  | {
      readonly type: 'link';
      readonly time: number;
      readonly a: string;
      readonly b: string;
      readonly config: LinkConfig;
    };

interface NetworkEvents extends Record<string, unknown> {
  event: NetworkEvent;
}

export interface SimPeer {
  readonly id: string;
  readonly doc: Doc;
  readonly awareness: Awareness;
}

export interface SimNetworkOptions {
  readonly scheduler: Scheduler;
  readonly seed?: number;
  readonly antiEntropyMs?: number;
}

const linkKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * In-process network of peers connected by simulated links with latency, jitter, loss,
 * duplication and partitions. Each peer runs a real Doc, Awareness and one SyncSession per
 * link, so what converges here is the same code that runs against the WebSocket server.
 * With a VirtualScheduler and a fixed seed every run is reproducible.
 */
export class SimNetwork {
  readonly #scheduler: Scheduler;
  readonly #rng: Rng;
  readonly #antiEntropyMs: number;
  readonly #peers = new Map<string, SimPeer>();
  readonly #links = new Map<string, LinkConfig>();
  /** Session owned by `from` for its link to `to`, keyed `from>to`. */
  readonly #sessions = new Map<string, SyncSession>();
  readonly #events = new Emitter<NetworkEvents>();
  #nextMessageId = 1;
  #inFlight = 0;

  constructor(options: SimNetworkOptions) {
    this.#scheduler = options.scheduler;
    this.#rng = new Rng(options.seed ?? 1);
    this.#antiEntropyMs = options.antiEntropyMs ?? 2000;
  }

  on(event: 'event', listener: (e: NetworkEvent) => void): () => void {
    return this.#events.on(event, listener);
  }

  addPeer(id: string): SimPeer {
    if (this.#peers.has(id)) throw new Error(`peer ${id} already exists`);
    const peer: SimPeer = {
      id,
      doc: new Doc({ replicaId: id }),
      awareness: new Awareness(id, { scheduler: this.#scheduler }),
    };
    this.#peers.set(id, peer);
    return peer;
  }

  peer(id: string): SimPeer {
    const peer = this.#peers.get(id);
    if (!peer) throw new Error(`unknown peer ${id}`);
    return peer;
  }

  peers(): SimPeer[] {
    return [...this.#peers.values()];
  }

  /** Messages scheduled for delivery and not yet delivered or dropped. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Creates the link a–b with one session on each side, connected if the link is up. */
  link(a: string, b: string, config: Partial<LinkConfig> = {}): void {
    if (a === b) throw new Error('cannot link a peer to itself');
    const key = linkKey(a, b);
    if (this.#links.has(key)) throw new Error(`link ${a}-${b} already exists`);
    const full = { ...DEFAULT_LINK, ...config };
    this.#links.set(key, full);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const peer = this.peer(from);
      this.#sessions.set(
        `${from}>${to}`,
        new SyncSession(peer.doc, {
          awareness: peer.awareness,
          scheduler: this.#scheduler,
          antiEntropyMs: this.#antiEntropyMs,
          send: (bytes) => {
            this.#transmit(from, to, bytes);
          },
        }),
      );
    }
    this.#emitLink(a, b, full);
    if (full.up) this.#connect(a, b);
  }

  getLink(a: string, b: string): LinkConfig {
    const config = this.#links.get(linkKey(a, b));
    if (!config) throw new Error(`no link between ${a} and ${b}`);
    return config;
  }

  /** Changes a link. Taking it down disconnects both sessions; bringing it up reconnects them. */
  setLink(a: string, b: string, patch: Partial<LinkConfig>): void {
    const before = this.getLink(a, b);
    const after = { ...before, ...patch };
    this.#links.set(linkKey(a, b), after);
    this.#emitLink(a, b, after);
    if (before.up && !after.up) {
      this.#session(a, b).disconnect();
      this.#session(b, a).disconnect();
    } else if (!before.up && after.up) {
      this.#connect(a, b);
    }
  }

  /** True when every peer holds the same document state and nothing is buffered. */
  isConverged(): boolean {
    let first: string | undefined;
    for (const peer of this.#peers.values()) {
      if (peer.doc.pendingCount > 0) return false;
      const state = JSON.stringify(peer.doc.debugState());
      if (first === undefined) first = state;
      else if (state !== first) return false;
    }
    return true;
  }

  destroy(): void {
    for (const session of this.#sessions.values()) session.destroy();
    for (const peer of this.#peers.values()) peer.awareness.destroy();
  }

  #session(from: string, to: string): SyncSession {
    const session = this.#sessions.get(`${from}>${to}`);
    if (!session) throw new Error(`no session ${from}>${to}`);
    return session;
  }

  #connect(a: string, b: string): void {
    this.#session(a, b).connect();
    this.#session(b, a).connect();
  }

  #emitLink(a: string, b: string, config: LinkConfig): void {
    this.#events.emit('event', { type: 'link', time: this.#scheduler.now(), a, b, config });
  }

  #transmit(from: string, to: string, bytes: Uint8Array): void {
    const config = this.getLink(from, to);
    const describe = this.#events.listenerCount('event') > 0;
    const info: MessageInfo = {
      time: this.#scheduler.now(),
      id: this.#nextMessageId++,
      from,
      to,
      size: bytes.length,
      summary: describe ? describeMessage(bytes) : '',
    };
    this.#events.emit('event', { type: 'send', ...info });
    if (!config.up) {
      this.#events.emit('event', { type: 'drop', reason: 'partition', ...info });
      return;
    }
    if (this.#rng.chance(config.loss)) {
      this.#events.emit('event', { type: 'drop', reason: 'loss', ...info });
      return;
    }
    this.#schedule(info, bytes, config);
    if (this.#rng.chance(config.duplicate)) {
      this.#events.emit('event', { type: 'duplicate', ...info });
      this.#schedule(info, bytes, config);
    }
  }

  #schedule(info: MessageInfo, bytes: Uint8Array, config: LinkConfig): void {
    const delay = config.latencyMs + this.#rng.next() * config.jitterMs;
    this.#inFlight++;
    this.#scheduler.setTimeout(() => {
      this.#inFlight--;
      const time = this.#scheduler.now();
      if (!this.getLink(info.from, info.to).up) {
        this.#events.emit('event', { type: 'drop', reason: 'partition', ...info, time });
        return;
      }
      this.#events.emit('event', { type: 'deliver', ...info, time });
      try {
        this.#session(info.to, info.from).receive(bytes);
      } catch (err) {
        this.#events.emit('event', {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          ...info,
          time,
        });
      }
    }, delay);
  }
}
