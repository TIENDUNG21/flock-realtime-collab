import type { VectorClock } from '@flock/crdt';
import {
  DecodeError,
  Reader,
  Writer,
  decodeStateVectorFrom,
  decodeUpdate,
  isValidReplicaId,
  readJson,
  writeJson,
  type Json,
  type ReplicaId,
} from '@flock/crdt';

/** Presence information of one replica. `state: null` means the replica left. */
export interface AwarenessEntry {
  readonly replica: ReplicaId;
  readonly clock: number;
  readonly state: Json | null;
}

/**
 * The four messages of the sync protocol.
 *
 * - `sync-step1`: "this is my state vector" — the receiver answers with `sync-step2`.
 * - `sync-step2`: the operations the step-1 sender was missing (possibly none).
 * - `update`: newly created or received operations, pushed as they happen.
 * - `awareness`: presence entries (cursors, names), last-writer-wins by per-replica clock.
 */
export type Message =
  | { readonly type: 'sync-step1'; readonly stateVector: VectorClock }
  | { readonly type: 'sync-step2'; readonly update: Uint8Array }
  | { readonly type: 'update'; readonly update: Uint8Array }
  | { readonly type: 'awareness'; readonly entries: readonly AwarenessEntry[] };

const TYPE_CODES = { 'sync-step1': 0, 'sync-step2': 1, update: 2, awareness: 3 } as const;

export function encodeMessage(msg: Message): Uint8Array {
  const w = new Writer();
  w.u8(TYPE_CODES[msg.type]);
  switch (msg.type) {
    case 'sync-step1': {
      const entries = msg.stateVector.entries();
      w.varUint(entries.length);
      for (const [replica, seq] of entries) {
        w.string(replica);
        w.varUint(seq);
      }
      break;
    }
    case 'sync-step2':
    case 'update':
      w.bytes(msg.update);
      break;
    case 'awareness':
      w.varUint(msg.entries.length);
      for (const entry of msg.entries) {
        w.string(entry.replica);
        w.varUint(entry.clock);
        if (entry.state === null) {
          w.u8(0);
        } else {
          w.u8(1);
          writeJson(w, entry.state);
        }
      }
      break;
  }
  return w.finish();
}

/** Decodes a message. Update payloads are checked as well, so a bad update fails here. */
export function decodeMessage(bytes: Uint8Array): Message {
  const r: Reader = new Reader(bytes);
  const code = r.u8();
  switch (code) {
    case TYPE_CODES['sync-step1']: {
      const stateVector = decodeStateVectorFrom(r);
      if (!r.done) r.fail('trailing bytes after state vector');
      return { type: 'sync-step1', stateVector };
    }
    case TYPE_CODES['sync-step2']:
    case TYPE_CODES.update: {
      const update = bytes.slice(1);
      try {
        decodeUpdate(update);
      } catch (err) {
        if (err instanceof DecodeError) throw new DecodeError(err.message, err.offset + 1);
        throw err;
      }
      return { type: code === TYPE_CODES.update ? 'update' : 'sync-step2', update };
    }
    case TYPE_CODES.awareness: {
      const count = r.varUint();
      if (count > r.remaining) r.fail(`awareness count ${count} exceeds the input`);
      const entries: AwarenessEntry[] = [];
      for (let i = 0; i < count; i++) {
        const at = r.offset;
        const replica = r.string();
        if (!isValidReplicaId(replica)) r.fail('invalid replica id in awareness entry', at);
        const clock = r.varUint();
        const flagAt = r.offset;
        const flag = r.u8();
        if (flag > 1) r.fail('invalid awareness state flag', flagAt);
        entries.push({ replica, clock, state: flag === 1 ? readJson(r) : null });
      }
      if (!r.done) r.fail('trailing bytes after awareness entries');
      return { type: 'awareness', entries };
    }
    default:
      return r.fail(`unknown message type ${code}`, 0);
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Human-readable one-line summary of an encoded message, for logs and the Partition Lab. */
export function describeMessage(bytes: Uint8Array): string {
  try {
    const msg = decodeMessage(bytes);
    switch (msg.type) {
      case 'sync-step1':
        return `sync-step1 (${plural(msg.stateVector.size, 'replica')})`;
      case 'sync-step2':
      case 'update':
        return `${msg.type} (${plural(decodeUpdate(msg.update).length, 'op')})`;
      case 'awareness':
        return `awareness (${plural(msg.entries.length, 'peer')})`;
    }
  } catch {
    return 'malformed message';
  }
}
