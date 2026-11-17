/** A replica (peer) identifier: a short, unique, non-empty string. */
export type ReplicaId = string;

/**
 * Identifies one unit of history: the `seq`-th operation unit created by `replica`.
 * Sequence numbers start at 1 and are consecutive per replica, which is what lets a
 * state vector (replica -> highest seq) describe exactly which history a peer holds.
 */
export interface Id {
  readonly replica: ReplicaId;
  readonly seq: number;
}

/**
 * A Lamport timestamp tagged with its replica. `(lamport, replica)` pairs are unique and
 * totally ordered, which gives every replica the same tie-breaking decision.
 */
export interface Stamp {
  readonly lamport: number;
  readonly replica: ReplicaId;
}

/** Maximum length (UTF-16 units) of a replica id. Keeps encoded updates small. */
export const MAX_REPLICA_ID_LENGTH = 64;

/** Total order on stamps: Lamport time first, then replica id (code unit order). */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}

export function idEquals(a: Id, b: Id): boolean {
  return a.seq === b.seq && a.replica === b.replica;
}

export function idToString(id: Id): string {
  return `${id.replica}@${id.seq}`;
}

export function isValidReplicaId(value: unknown): value is ReplicaId {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REPLICA_ID_LENGTH;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

/** Generates a random 12-character replica id, using Web Crypto when available. */
export function randomReplicaId(): ReplicaId {
  const bytes = new Uint8Array(12);
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length] ?? '0';
  return out;
}
