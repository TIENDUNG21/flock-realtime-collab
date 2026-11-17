import { VectorClock } from '../clock/vector.js';
import { DecodeError, InvalidOpError } from '../errors.js';
import { isValidReplicaId, type Id, type ReplicaId } from '../id.js';
import type { Json } from '../json.js';
import { opLength, validateOp, type IdRange, type Op } from '../ops.js';
import { Reader, Writer, checkCount } from './buffer.js';
import { readJson, writeJson } from './json.js';

/** Version byte at the start of every encoded update. */
export const UPDATE_FORMAT_VERSION = 1;

// Op header byte: bits 0-1 kind, then flags.
const KIND_INS = 0;
const KIND_DEL = 1;
const KIND_SET = 2;
const KIND_MASK = 0b11;
/** Target is the same as the previous op in the group (target index omitted). */
const SAME_TARGET = 1 << 2;
/** Lamport time is previous op's last time + 1 (lamport field omitted). */
const NEXT_LAMPORT = 1 << 3;
/** Insert: origin is the previous unit of the same replica (origin omitted). */
const ORIGIN_PREV = 1 << 4;
/** Insert: origin is the start of the text. Set: value is a deletion. */
const FLAG_NULL = 1 << 5;
const KNOWN_FLAGS = KIND_MASK | SAME_TARGET | NEXT_LAMPORT | ORIGIN_PREV | FLAG_NULL;

class StringTable {
  readonly list: string[] = [];
  readonly #index = new Map<string, number>();

  add(value: string): void {
    if (!this.#index.has(value)) {
      this.#index.set(value, this.list.length);
      this.list.push(value);
    }
  }

  indexOf(value: string): number {
    const index = this.#index.get(value);
    if (index === undefined) throw new Error(`string not in table: ${value}`);
    return index;
  }
}

/** Splits ops into runs of one replica with consecutive ids, sorted by replica then seq. */
function groupOps(ops: readonly Op[]): Op[][] {
  const byReplica = new Map<ReplicaId, Op[]>();
  for (const op of ops) {
    let list = byReplica.get(op.id.replica);
    if (!list) byReplica.set(op.id.replica, (list = []));
    list.push(op);
  }
  const groups: Op[][] = [];
  for (const replica of [...byReplica.keys()].sort()) {
    const list = (byReplica.get(replica) ?? []).sort((a, b) => a.id.seq - b.id.seq);
    let current: Op[] = [];
    let nextSeq = -1;
    for (const op of list) {
      if (op.id.seq < nextSeq) continue; // duplicate or overlapping op: keep the first
      if (op.id.seq !== nextSeq && current.length > 0) {
        groups.push(current);
        current = [];
      }
      current.push(op);
      nextSeq = op.id.seq + opLength(op);
    }
    if (current.length > 0) groups.push(current);
  }
  return groups;
}

/**
 * Encodes operations into the compact binary update format:
 *
 * ```
 * update := version:u8  strings:(count, string*)  groups:(count, group*)
 * group  := replica:strIdx  firstSeq:varuint  opCount:varuint  op*
 * op     := header:u8  [lamportGap:varuint]  [target:strIdx]  body
 * ```
 *
 * Within a group seqs are implicit (each op starts where the previous one ended), Lamport
 * times are delta-coded, and the common "typed right after my previous character" origin
 * costs a single flag bit. Duplicate operations are dropped.
 */
export function encodeUpdate(ops: readonly Op[]): Uint8Array {
  const groups = groupOps(ops);
  const strings = new StringTable();
  for (const group of groups) {
    for (const op of group) {
      strings.add(op.id.replica);
      strings.add(op.target);
      if (op.kind === 'ins' && op.origin) strings.add(op.origin.replica);
      if (op.kind === 'del') for (const r of op.ranges) strings.add(r.replica);
    }
  }
  const w = new Writer();
  w.u8(UPDATE_FORMAT_VERSION);
  w.varUint(strings.list.length);
  for (const s of strings.list) w.string(s);
  w.varUint(groups.length);
  for (const group of groups) {
    const first = group[0];
    if (!first) continue;
    w.varUint(strings.indexOf(first.id.replica));
    w.varUint(first.id.seq);
    w.varUint(group.length);
    let lastLamport = 0;
    let lastTarget = '';
    for (const op of group) {
      const length = opLength(op);
      let header = op.kind === 'ins' ? KIND_INS : op.kind === 'del' ? KIND_DEL : KIND_SET;
      if (op.target === lastTarget) header |= SAME_TARGET;
      if (op.lamport === lastLamport + 1) header |= NEXT_LAMPORT;
      if (op.kind === 'ins') {
        if (op.origin === null) header |= FLAG_NULL;
        else if (op.origin.replica === op.id.replica && op.origin.seq === op.id.seq - 1) {
          header |= ORIGIN_PREV;
        }
      }
      if (op.kind === 'set' && op.value === undefined) header |= FLAG_NULL;
      w.u8(header);
      if (!(header & NEXT_LAMPORT)) w.varUint(op.lamport - lastLamport - 1);
      if (!(header & SAME_TARGET)) w.varUint(strings.indexOf(op.target));
      if (op.kind === 'ins') {
        if (!(header & (FLAG_NULL | ORIGIN_PREV)) && op.origin) {
          w.varUint(strings.indexOf(op.origin.replica));
          w.varUint(op.origin.seq);
        }
        w.string(op.content);
      } else if (op.kind === 'del') {
        w.varUint(op.ranges.length);
        for (const r of op.ranges) {
          w.varUint(strings.indexOf(r.replica));
          w.varUint(r.seq);
          w.varUint(r.len);
        }
      } else {
        w.string(op.key);
        if (op.value !== undefined) writeJson(w, op.value);
      }
      lastLamport = op.lamport + length - 1;
      lastTarget = op.target;
    }
  }
  return w.finish();
}

/** Decodes an update. Throws DecodeError (with byte offset) for any malformed input. */
export function decodeUpdate(bytes: Uint8Array): Op[] {
  const r: Reader = new Reader(bytes);
  const version = r.u8();
  if (version !== UPDATE_FORMAT_VERSION) r.fail(`unsupported update format version ${version}`, 0);
  const stringCount = r.varUint();
  checkCount(r, stringCount, 'string table');
  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) strings.push(r.string());
  const str = (): string => {
    const at = r.offset;
    const s = strings[r.varUint()];
    if (s === undefined) r.fail('string index out of range', at);
    return s;
  };
  const replica = (): ReplicaId => {
    const at = r.offset;
    const s = str();
    if (!isValidReplicaId(s)) r.fail('invalid replica id', at);
    return s;
  };

  const ops: Op[] = [];
  const groupCount = r.varUint();
  checkCount(r, groupCount, 'group');
  for (let g = 0; g < groupCount; g++) {
    const groupReplica = replica();
    let seq = r.varUint();
    const opCount = r.varUint();
    checkCount(r, opCount, 'operation');
    let lastLamport = 0;
    let lastTarget: string | null = null;
    for (let i = 0; i < opCount; i++) {
      const at = r.offset;
      const header = r.u8();
      if ((header & ~KNOWN_FLAGS) !== 0 || (header & KIND_MASK) === 3) {
        r.fail(`invalid operation header 0x${header.toString(16)}`, at);
      }
      const lamport = header & NEXT_LAMPORT ? lastLamport + 1 : lastLamport + 1 + r.varUint();
      let target: string;
      if (header & SAME_TARGET) {
        if (lastTarget === null) r.fail('first operation of a group cannot reuse the target', at);
        target = lastTarget;
      } else {
        target = str();
      }
      const id: Id = { replica: groupReplica, seq };
      let op: Op;
      switch (header & KIND_MASK) {
        case KIND_INS: {
          let origin: Id | null = null;
          if (header & ORIGIN_PREV) origin = { replica: groupReplica, seq: seq - 1 };
          else if (!(header & FLAG_NULL)) origin = { replica: replica(), seq: r.varUint() };
          op = { kind: 'ins', id, lamport, target, origin, content: r.string() };
          break;
        }
        case KIND_DEL: {
          const rangeCount = r.varUint();
          checkCount(r, rangeCount, 'range');
          const ranges: IdRange[] = [];
          for (let k = 0; k < rangeCount; k++) {
            ranges.push({ replica: replica(), seq: r.varUint(), len: r.varUint() });
          }
          op = { kind: 'del', id, lamport, target, ranges };
          break;
        }
        default: {
          const key = r.string();
          const value: Json | undefined = header & FLAG_NULL ? undefined : readJson(r);
          op = { kind: 'set', id, lamport, target, key, value };
        }
      }
      try {
        op = validateOp(op);
      } catch (err) {
        if (err instanceof InvalidOpError) throw new DecodeError(err.message, at);
        throw err;
      }
      ops.push(op);
      const length = opLength(op);
      seq += length;
      lastLamport = lamport + length - 1;
      lastTarget = target;
    }
  }
  if (!r.done) r.fail('trailing bytes after update');
  return ops;
}

/** Combines several updates into one, dropping duplicate operations. */
export function mergeUpdates(updates: readonly Uint8Array[]): Uint8Array {
  return encodeUpdate(updates.flatMap((u) => decodeUpdate(u)));
}

export function encodeStateVector(sv: VectorClock): Uint8Array {
  const w = new Writer();
  const entries = sv.entries();
  w.varUint(entries.length);
  for (const [replica, seq] of entries) {
    w.string(replica);
    w.varUint(seq);
  }
  return w.finish();
}

export function decodeStateVector(bytes: Uint8Array): VectorClock {
  const r: Reader = new Reader(bytes);
  const sv = decodeStateVectorFrom(r);
  if (!r.done) r.fail('trailing bytes after state vector');
  return sv;
}

/** Reads a state vector from the middle of a larger message. */
export function decodeStateVectorFrom(r: Reader): VectorClock {
  const count = r.varUint();
  checkCount(r, count, 'state vector entry');
  const sv = new VectorClock();
  for (let i = 0; i < count; i++) {
    const at = r.offset;
    const replica = r.string();
    if (!isValidReplicaId(replica)) r.fail('invalid replica id in state vector', at);
    if (sv.get(replica) !== 0) r.fail('duplicate replica in state vector', at);
    sv.set(replica, r.varUint());
  }
  return sv;
}
