import { Emitter, type Doc } from '@flock/crdt';
import type { Awareness } from './awareness.js';
import { realScheduler, type Scheduler, type TimerHandle } from './scheduler.js';
import { SyncSession } from './session.js';

/** The subset of the WHATWG WebSocket API the provider uses (browsers, Node 22+, `ws`). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected';

export interface WebSocketProviderOptions {
  readonly awareness?: Awareness;
  readonly scheduler?: Scheduler;
  /** Creates sockets; defaults to the global `WebSocket`. */
  readonly createSocket?: WebSocketFactory;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Random source for backoff jitter (inject for deterministic tests). */
  readonly random?: () => number;
  readonly antiEntropyMs?: number;
  /** Connect immediately (default true). */
  readonly connect?: boolean;
}

interface ProviderEvents extends Record<string, unknown> {
  status: ProviderStatus;
  synced: undefined;
  error: Error;
}

const OPEN = 1;

function defaultFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('no global WebSocket; pass createSocket');
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/**
 * Connects a Doc (and Awareness) to a Flock server room over WebSocket and keeps it connected:
 * unexpected closes trigger reconnects with capped exponential backoff and jitter. Edits made
 * while offline wait in the session outbox and are sent on reconnect.
 */
export class WebSocketProvider {
  readonly url: string;
  readonly session: SyncSession;
  readonly #createSocket: WebSocketFactory;
  readonly #scheduler: Scheduler;
  readonly #minBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #random: () => number;
  readonly #events = new Emitter<ProviderEvents>();
  #socket: WebSocketLike | null = null;
  #status: ProviderStatus = 'disconnected';
  #wanted = false;
  #attempts = 0;
  #retryTimer: TimerHandle | null = null;
  #destroyed = false;

  constructor(serverUrl: string, room: string, doc: Doc, options: WebSocketProviderOptions = {}) {
    this.url = `${serverUrl.replace(/\/+$/, '')}/rooms/${encodeURIComponent(room)}`;
    this.#createSocket = options.createSocket ?? defaultFactory;
    this.#scheduler = options.scheduler ?? realScheduler;
    this.#minBackoffMs = options.minBackoffMs ?? 250;
    this.#maxBackoffMs = options.maxBackoffMs ?? 8000;
    this.#random = options.random ?? Math.random;
    this.session = new SyncSession(doc, {
      ...(options.awareness ? { awareness: options.awareness } : {}),
      scheduler: this.#scheduler,
      antiEntropyMs: options.antiEntropyMs ?? 10_000,
      send: (bytes) => {
        if (this.#socket?.readyState === OPEN) this.#socket.send(bytes);
      },
    });
    this.session.on('synced', () => {
      this.#events.emit('synced', undefined);
    });
    if (options.connect ?? true) this.connect();
  }

  on<K extends keyof ProviderEvents>(
    event: K,
    listener: (payload: ProviderEvents[K]) => void,
  ): () => void {
    return this.#events.on(event, listener);
  }

  get status(): ProviderStatus {
    return this.#status;
  }

  get synced(): boolean {
    return this.session.synced;
  }

  /** Delay before the given reconnect attempt (0-based), before jitter. */
  backoffFor(attempt: number): number {
    return Math.min(this.#maxBackoffMs, this.#minBackoffMs * 2 ** attempt);
  }

  connect(): void {
    if (this.#destroyed) return;
    this.#wanted = true;
    if (this.#socket || this.#retryTimer) return;
    this.#open();
  }

  /** Closes the connection and stays offline until `connect` is called. */
  disconnect(): void {
    this.#wanted = false;
    if (this.#retryTimer) this.#scheduler.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = socket.onclose = socket.onmessage = socket.onerror = null;
      socket.close(1000, 'client disconnect');
    }
    this.session.disconnect();
    this.#setStatus('disconnected');
  }

  destroy(): void {
    this.disconnect();
    this.#destroyed = true;
    this.session.destroy();
  }

  #open(): void {
    this.#setStatus('connecting');
    let socket: WebSocketLike;
    try {
      socket = this.#createSocket(this.url);
    } catch (err) {
      this.#events.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.#scheduleRetry();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempts = 0;
      this.#setStatus('connected');
      this.session.connect();
    };
    socket.onmessage = (event) => {
      const bytes = toBytes(event.data);
      if (!bytes) return;
      try {
        this.session.receive(bytes);
      } catch (err) {
        this.#events.emit('error', err instanceof Error ? err : new Error(String(err)));
        socket.close(1007, 'malformed message');
      }
    };
    socket.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.session.disconnect();
      this.#setStatus('disconnected');
      if (this.#wanted) this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    if (this.#destroyed || this.#retryTimer) return;
    const base = this.backoffFor(this.#attempts++);
    const delay = base / 2 + this.#random() * (base / 2);
    this.#retryTimer = this.#scheduler.setTimeout(() => {
      this.#retryTimer = null;
      if (this.#wanted) this.#open();
    }, delay);
  }

  #setStatus(status: ProviderStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#events.emit('status', status);
  }
}
