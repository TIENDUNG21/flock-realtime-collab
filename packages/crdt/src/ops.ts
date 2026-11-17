import { InvalidOpError } from './errors.js';
import { isValidReplicaId, type Id, type ReplicaId } from './id.js';
import { freezeJson, type Json } from './json.js';
import { codePointCount, isWellFormed } from './text/codepoints.js';

/** Maximum length of a shared type name. */
export const MAX_TARGET_LENGTH = 256;

/**
 * Insert a run of characters into a text. A run of k code points occupies the ids
 * `seq .. seq+k-1` and the Lamport times `lamport .. lamport+k-1`; character i > 0 is
 * inserted after character i - 1 of the same run.
 */
export interface InsertOp {
  readonly kind: 'ins';
  readonly id: Id;
  readonly lamport: number;
  readonly target: string;
  /** The character this run is inserted after; `null` means the start of the text. */
  readonly origin: Id | null;
  readonly content: string;
}

/** A contiguous range of ids `(replica, seq .. seq+len-1)`. */
export interface IdRange {
  readonly replica: ReplicaId;
  readonly seq: number;
  readonly len: number;
}

/** Delete (tombstone) characters of a text. Occupies one id. */
export interface DeleteOp {
  readonly kind: 'del';
  readonly id: Id;
  readonly lamport: number;
  readonly target: string;
  readonly ranges: readonly IdRange[];
}

/** Set (or delete, with `value: undefined`) a key of a map. Occupies one id. */
export interface SetOp {
  readonly kind: 'set';
  readonly id: Id;
  readonly lamport: number;
  readonly target: string;
  readonly key: string;
  readonly value: Json | undefined;
}

export type Op = InsertOp | DeleteOp | SetOp;

/** The shared type an operation kind applies to. */
export type TypeKind = 'text' | 'map';

export function typeKindOf(op: Op): TypeKind {
  return op.kind === 'set' ? 'map' : 'text';
}

/** Number of ids (and Lamport times) an operation occupies. */
export function opLength(op: Op): number {
  return op.kind === 'ins' ? codePointCount(op.content) : 1;
}

const isPositiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;

function checkId(id: unknown, what: string): void {
  const candidate = id as Partial<Id> | null;
  if (typeof candidate !== 'object' || candidate === null)
    throw new InvalidOpError(`${what} is not an id`);
  if (!isValidReplicaId(candidate.replica))
    throw new InvalidOpError(`${what} has an invalid replica id`);
  if (!isPositiveInt(candidate.seq))
    throw new InvalidOpError(`${what} has an invalid sequence number`);
}

/**
 * Structural validation for operations received from other replicas. Returns the operation
 * with map values copied and frozen. Throws InvalidOpError describing the first problem.
 */
export function validateOp(input: Op): Op {
  const op = input as Partial<Op> & { kind?: unknown };
  checkId(op.id, 'operation id');
  if (!isPositiveInt(op.lamport)) throw new InvalidOpError('operation has an invalid Lamport time');
  if (
    typeof op.target !== 'string' ||
    op.target.length === 0 ||
    op.target.length > MAX_TARGET_LENGTH
  ) {
    throw new InvalidOpError('operation has an invalid target name');
  }
  const id = input.id;
  switch (op.kind) {
    case 'ins': {
      const ins = input as InsertOp;
      if (ins.origin !== null) checkId(ins.origin, 'insert origin');
      if (typeof ins.content !== 'string' || ins.content.length === 0) {
        throw new InvalidOpError('insert content must be a non-empty string');
      }
      if (!isWellFormed(ins.content))
        throw new InvalidOpError('insert content contains a lone surrogate');
      const len = codePointCount(ins.content);
      if (!Number.isSafeInteger(id.seq + len) || !Number.isSafeInteger(ins.lamport + len)) {
        throw new InvalidOpError('insert run overflows the id space');
      }
      return ins;
    }
    case 'del': {
      const del = input as DeleteOp;
      const ranges: unknown = del.ranges;
      if (!Array.isArray(ranges) || ranges.length === 0) {
        throw new InvalidOpError('delete must name at least one range');
      }
      for (const range of del.ranges) {
        checkId(range, 'delete range');
        if (!isPositiveInt(range.len) || !Number.isSafeInteger(range.seq + range.len)) {
          throw new InvalidOpError('delete range has an invalid length');
        }
      }
      return del;
    }
    case 'set': {
      const set = input as SetOp;
      if (typeof set.key !== 'string') throw new InvalidOpError('map key must be a string');
      if (set.value === undefined) return set;
      try {
        return { ...set, value: freezeJson(set.value) };
      } catch (err) {
        throw new InvalidOpError(`map value is not JSON: ${(err as Error).message}`);
      }
    }
    default:
      throw new InvalidOpError(`unknown operation kind ${String(op.kind)}`);
  }
}
