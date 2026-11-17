import { Doc } from '@flock/crdt';
import { Awareness, SyncSession } from '@flock/sync';
import { errorMessage, type Logger } from './logger.js';
import { LogStore } from './store.js';

/** Origin used while replaying the log, so replayed updates are not appended again. */
const STORE_ORIGIN = Symbol('store');

export interface RoomOptions {
  readonly dataDir: string;
  /** Rewrite the log as one snapshot once it holds this many records. */
  readonly compactEvery: number;
  readonly fsync: boolean;
  readonly logger: Logger;
}

/** A connected client as seen by the room. */
export interface RoomClient {
  /** Handles one binary message. Throws DecodeError / InvalidOpError for malformed input. */
  receive(bytes: Uint8Array): void;
  /** Detaches the client and announces that its presence is gone. */
  leave(): void;
}

/**
 * One collaborative document on the server. The server is an ordinary peer: it holds a replica
 * of the document (so it can answer any state vector with a delta), relays updates and presence
 * between its clients through one SyncSession each, and appends every new update to disk.
 */
export class Room {
  readonly name: string;
  readonly doc = new Doc({ replicaId: 'server' });
  readonly awareness: Awareness;
  readonly #store: LogStore;
  readonly #sessions = new Set<SyncSession>();
  readonly #logger: Logger;
  #closed = false;

  private constructor(name: string, store: LogStore, logger: Logger) {
    this.name = name;
    this.#store = store;
    this.#logger = logger;
    this.awareness = new Awareness(this.doc.replicaId);
  }

  /** Opens the room's log and replays it into a fresh document. */
  static open(name: string, options: RoomOptions): Room {
    const { store, records, repaired } = LogStore.open(options.dataDir, name, {
      fsync: options.fsync,
    });
    const room = new Room(name, store, options.logger);
    if (repaired) options.logger.warn('cut a torn record off the end of the log', { room: name });
    for (const [index, record] of records.entries()) {
      try {
        room.doc.applyUpdate(record, STORE_ORIGIN);
      } catch (err) {
        options.logger.warn('skipped an unreadable log record', {
          room: name,
          index,
          error: errorMessage(err),
        });
      }
    }
    room.doc.on('update', (event) => {
      if (event.origin === STORE_ORIGIN || room.#closed) return;
      store.append(event.update);
      if (store.recordCount >= options.compactEvery) {
        store.compact(room.doc.encodeStateAsUpdate());
        options.logger.info('compacted room log', { room: name });
      }
    });
    options.logger.info('opened room', { room: name, records: records.length });
    return room;
  }

  get clientCount(): number {
    return this.#sessions.size;
  }

  join(send: (bytes: Uint8Array) => void): RoomClient {
    if (this.#closed) throw new Error(`room ${this.name} is closed`);
    // Clients run anti-entropy; the server only answers, so it does not need its own timer.
    const session = new SyncSession(this.doc, {
      awareness: this.awareness,
      send,
      antiEntropyMs: 0,
    });
    this.#sessions.add(session);
    session.connect();
    return {
      receive: (bytes) => {
        session.receive(bytes);
      },
      leave: () => {
        if (!this.#sessions.delete(session)) return;
        session.destroy();
        this.awareness.removeStates([...session.remoteReplicas], session);
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions) session.destroy();
    this.#sessions.clear();
    this.awareness.destroy();
    this.#store.close();
    this.#logger.info('closed room', { room: this.name });
  }
}
