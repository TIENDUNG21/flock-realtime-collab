import { Emitter, type TextType } from '@flock/crdt';
import {
  Rng,
  SimNetwork,
  type LinkConfig,
  type NetworkEvent,
  type Scheduler,
  type TimerHandle,
} from '@flock/sync';

export const PEERS = ['A', 'B', 'C'] as const;
export type PeerId = (typeof PEERS)[number];
export const LINKS: ReadonlyArray<readonly [PeerId, PeerId]> = [
  ['A', 'B'],
  ['B', 'C'],
  ['A', 'C'],
];

export const TEXT_NAME = 'text';

export interface LogEntry {
  readonly id: number;
  readonly time: number;
  readonly kind: 'deliver' | 'drop' | 'duplicate' | 'link' | 'error';
  readonly from?: PeerId;
  readonly to?: PeerId;
  readonly summary: string;
  readonly detail: string;
  /** True for state-vector exchanges that carried no operations. */
  readonly handshake: boolean;
}

export interface Stats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  bytes: number;
}

export type Convergence =
  | { readonly state: 'converged' }
  | { readonly state: 'syncing'; readonly inFlight: number }
  | { readonly state: 'diverged'; readonly cut: ReadonlyArray<readonly [PeerId, PeerId]> };

interface LabEvents extends Record<string, unknown> {
  log: LogEntry;
  network: NetworkEvent;
}

export interface LabOptions {
  readonly scheduler: Scheduler;
  readonly seed?: number;
  readonly antiEntropyMs?: number;
  readonly logLimit?: number;
}

const WORDS = [
  'local',
  'first',
  'peers',
  'merge',
  'always',
  'converge',
  'offline',
  'sync',
  'delta',
  'clock',
];

/**
 * The Partition Lab without the DOM: three peers on a simulated network, link controls,
 * a bounded operation log, traffic statistics, convergence status and a "chaos typist".
 */
export class LabModel {
  readonly network: SimNetwork;
  readonly stats: Stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, bytes: 0 };
  readonly #scheduler: Scheduler;
  readonly #events = new Emitter<LabEvents>();
  readonly #log: LogEntry[] = [];
  readonly #logLimit: number;
  readonly #rng: Rng;
  readonly #start: number;
  #nextLogId = 1;
  #chaosTimer: TimerHandle | null = null;

  constructor(options: LabOptions) {
    this.#scheduler = options.scheduler;
    this.#logLimit = options.logLimit ?? 400;
    this.#rng = new Rng((options.seed ?? 1) ^ 0x5bd1e995);
    this.#start = options.scheduler.now();
    this.network = new SimNetwork({
      scheduler: options.scheduler,
      seed: options.seed ?? 1,
      antiEntropyMs: options.antiEntropyMs ?? 1500,
    });
    this.network.on('event', (e) => {
      this.#onNetwork(e);
    });
    for (const id of PEERS) this.network.addPeer(id);
    for (const [a, b] of LINKS) this.network.link(a, b, { latencyMs: 300, jitterMs: 120 });
  }

  on<K extends keyof LabEvents>(event: K, listener: (payload: LabEvents[K]) => void): () => void {
    return this.#events.on(event, listener);
  }

  text(peer: PeerId): TextType {
    return this.network.peer(peer).doc.getText(TEXT_NAME);
  }

  link(a: PeerId, b: PeerId): LinkConfig {
    return this.network.getLink(a, b);
  }

  setLink(a: PeerId, b: PeerId, patch: Partial<LinkConfig>): void {
    this.network.setLink(a, b, patch);
  }

  /** Cuts every link of `peer` (it keeps working offline). */
  isolate(peer: PeerId): void {
    for (const [a, b] of LINKS) if (a === peer || b === peer) this.setLink(a, b, { up: false });
  }

  /** Brings every link up and removes loss. */
  heal(): void {
    for (const [a, b] of LINKS) this.setLink(a, b, { up: true, loss: 0 });
  }

  isOnline(peer: PeerId): boolean {
    return LINKS.some(([a, b]) => (a === peer || b === peer) && this.link(a, b).up);
  }

  convergence(): Convergence {
    if (this.network.isConverged()) return { state: 'converged' };
    const cut = LINKS.filter(([a, b]) => !this.link(a, b).up);
    const inFlight = this.network.inFlight;
    if (inFlight > 0 && cut.length === 0) return { state: 'syncing', inFlight };
    return cut.length > 0 ? { state: 'diverged', cut } : { state: 'syncing', inFlight };
  }

  /** The newest entries, oldest first. */
  log(): readonly LogEntry[] {
    return this.#log;
  }

  /** Elapsed lab time in milliseconds. */
  elapsed(): number {
    return this.#scheduler.now() - this.#start;
  }

  get chaosRunning(): boolean {
    return this.#chaosTimer !== null;
  }

  /** Starts random edits on random peers every `intervalMs` (about). */
  startChaos(intervalMs = 350): void {
    if (this.#chaosTimer) return;
    const tick = (): void => {
      this.chaosStep();
      this.#chaosTimer = this.#scheduler.setTimeout(tick, intervalMs * (0.5 + this.#rng.next()));
    };
    this.#chaosTimer = this.#scheduler.setTimeout(tick, intervalMs);
  }

  stopChaos(): void {
    if (this.#chaosTimer) this.#scheduler.clearTimeout(this.#chaosTimer);
    this.#chaosTimer = null;
  }

  /** One random edit at a word boundary: usually a new word, sometimes a deleted word. */
  chaosStep(): void {
    const peer = this.#rng.pick(PEERS);
    const text = this.text(peer);
    // Work in code points so positions never split a surrogate pair (users may type emoji).
    const chars = Array.from(text.toString());
    const offset = (cp: number): number => chars.slice(0, cp).join('').length;
    const starts = [0];
    for (let i = 1; i < chars.length; i++) if (/\s/.test(chars[i - 1] ?? '')) starts.push(i);
    const start = this.#rng.pick(starts);
    if (chars.length > 60 && this.#rng.chance(0.3)) {
      let end = start;
      while (end < chars.length && !/\s/.test(chars[end] ?? '')) end++;
      if (end < chars.length) end++; // take the following space too
      if (end > start) text.delete(offset(start), offset(end) - offset(start));
    } else {
      text.insert(offset(start), `${this.#rng.pick(WORDS)}-${peer.toLowerCase()} `);
    }
  }

  destroy(): void {
    this.stopChaos();
    this.network.destroy();
  }

  #push(entry: Omit<LogEntry, 'id' | 'time'>): void {
    const full: LogEntry = { id: this.#nextLogId++, time: this.elapsed(), ...entry };
    this.#log.push(full);
    if (this.#log.length > this.#logLimit) this.#log.splice(0, this.#log.length - this.#logLimit);
    this.#events.emit('log', full);
  }

  #onNetwork(e: NetworkEvent): void {
    this.#events.emit('network', e);
    if (e.type === 'link') {
      const c = e.config;
      const state = c.up ? `up, ${c.latencyMs} ms, ${Math.round(c.loss * 100)}% loss` : 'cut';
      this.#push({
        kind: 'link',
        summary: `link ${e.a}-${e.b} ${state}`,
        detail: '',
        handshake: false,
      });
      return;
    }
    const from = e.from as PeerId;
    const to = e.to as PeerId;
    const handshake = /^sync-step[12] \(0 ops\)$|^sync-step1/.test(e.summary);
    switch (e.type) {
      case 'send':
        this.stats.sent++;
        this.stats.bytes += e.size;
        break;
      case 'transit':
        break;
      case 'deliver':
        this.stats.delivered++;
        this.#push({
          kind: 'deliver',
          from,
          to,
          summary: e.summary,
          detail: `${e.size} B`,
          handshake,
        });
        break;
      case 'duplicate':
        this.stats.duplicated++;
        this.#push({
          kind: 'duplicate',
          from,
          to,
          summary: e.summary,
          detail: 'duplicated',
          handshake,
        });
        break;
      case 'drop':
        this.stats.dropped++;
        this.#push({
          kind: 'drop',
          from,
          to,
          summary: e.summary,
          detail: e.reason === 'loss' ? 'lost' : 'cut by partition',
          handshake,
        });
        break;
      case 'error':
        this.#push({
          kind: 'error',
          from,
          to,
          summary: e.summary,
          detail: e.message,
          handshake: false,
        });
        break;
    }
  }
}
