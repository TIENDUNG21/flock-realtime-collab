import { compareStamps, type Id, type ReplicaId } from '../id.js';
import type { DeleteOp, IdRange, InsertOp } from '../ops.js';
import { splitCodePoints } from './codepoints.js';

/** One character (code point) of the sequence. Deleted items stay as tombstones. */
export interface Item {
  readonly replica: ReplicaId;
  readonly seq: number;
  readonly lamport: number;
  readonly content: string;
  deleted: boolean;
  prev: Item | null;
  next: Item | null;
}

/** Result of locating a UTF-16 offset among the visible items. */
interface Seek {
  /** Last visible item that ends at or before the offset, or null at the start. */
  readonly before: Item | null;
  /** First visible item that starts at the offset, or null at the end. */
  readonly at: Item | null;
}

/**
 * Replicated Growable Array (RGA): the sequence CRDT behind text.
 *
 * Items form a doubly linked list in document order, starting at a sentinel head. A new item
 * is placed after its origin, skipping every following item whose stamp is greater than its own.
 * Lamport stamps make every item greater than its causal predecessors, so the skipped items are
 * exactly the concurrent siblings that win the tie (and their descendants). The result does not
 * depend on the order in which concurrent inserts arrive.
 */
export class Rga {
  readonly #head: Item = {
    replica: '',
    seq: 0,
    lamport: 0,
    content: '',
    deleted: true,
    prev: null,
    next: null,
  };
  readonly #index = new Map<ReplicaId, Map<number, Item>>();
  #length = 0;
  #size = 0;
  #text: string | null = '';

  /** Visible length in UTF-16 code units. */
  get length(): number {
    return this.#length;
  }

  /** Number of items, including tombstones. */
  get size(): number {
    return this.#size;
  }

  find(id: Id): Item | undefined {
    return this.#index.get(id.replica)?.get(id.seq);
  }

  integrateInsert(op: InsertOp): void {
    const chars = splitCodePoints(op.content);
    let origin: Item = op.origin ? this.#require(op.origin) : this.#head;
    let byReplica = this.#index.get(op.id.replica);
    if (!byReplica) {
      byReplica = new Map();
      this.#index.set(op.id.replica, byReplica);
    }
    for (let i = 0; i < chars.length; i++) {
      const item: Item = {
        replica: op.id.replica,
        seq: op.id.seq + i,
        lamport: op.lamport + i,
        content: chars[i] ?? '',
        deleted: false,
        prev: null,
        next: null,
      };
      let ref = origin;
      let next = ref.next;
      while (next !== null && compareStamps(next, item) > 0) {
        ref = next;
        next = next.next;
      }
      item.prev = ref;
      item.next = next;
      ref.next = item;
      if (next) next.prev = item;
      byReplica.set(item.seq, item);
      this.#length += item.content.length;
      this.#size++;
      origin = item;
    }
    this.#text = null;
  }

  /** Tombstones the targeted items. Returns how many became deleted (0 for duplicates). */
  integrateDelete(op: DeleteOp): number {
    let count = 0;
    for (const range of op.ranges) {
      const byReplica = this.#index.get(range.replica);
      for (let seq = range.seq; seq < range.seq + range.len; seq++) {
        const item = byReplica?.get(seq);
        if (item && !item.deleted) {
          item.deleted = true;
          this.#length -= item.content.length;
          count++;
        }
      }
    }
    if (count > 0) this.#text = null;
    return count;
  }

  /** The id to use as origin when inserting at UTF-16 offset `index`. */
  originAt(index: number): Id | null {
    const { before } = this.#seek(index);
    return before ? { replica: before.replica, seq: before.seq } : null;
  }

  /** The visible item starting at `index` (null at the end of the text). */
  itemAt(index: number): Item | null {
    return this.#seek(index).at;
  }

  /** The visible item ending at `index` (null at the start of the text). */
  itemBefore(index: number): Item | null {
    return this.#seek(index).before;
  }

  /** Id ranges of the visible items covering `[index, index + len)`, merged where contiguous. */
  rangesAt(index: number, len: number): IdRange[] {
    this.#checkRange(index + len);
    let item = this.#seek(index).at;
    const ranges: Array<{ replica: ReplicaId; seq: number; len: number }> = [];
    let remaining = len;
    while (remaining > 0 && item) {
      if (!item.deleted) {
        if (item.content.length > remaining) {
          throw new RangeError('delete range ends inside a surrogate pair');
        }
        const last = ranges[ranges.length - 1];
        if (last?.replica === item.replica && last.seq + last.len === item.seq) last.len++;
        else ranges.push({ replica: item.replica, seq: item.seq, len: 1 });
        remaining -= item.content.length;
      }
      item = item.next;
    }
    return ranges;
  }

  /** Visible UTF-16 units before `item`. */
  offsetOf(item: Item): number {
    let offset = 0;
    for (let cur = this.#head.next; cur && cur !== item; cur = cur.next) {
      if (!cur.deleted) offset += cur.content.length;
    }
    return offset;
  }

  toString(): string {
    if (this.#text === null) {
      let out = '';
      for (let cur = this.#head.next; cur; cur = cur.next) if (!cur.deleted) out += cur.content;
      this.#text = out;
    }
    return this.#text;
  }

  /** All items in document order, including tombstones. */
  *items(): IterableIterator<Item> {
    for (let cur = this.#head.next; cur; cur = cur.next) yield cur;
  }

  #require(id: Id): Item {
    const item = this.find(id);
    if (!item) throw new Error(`RGA invariant violated: unknown origin ${id.replica}@${id.seq}`);
    return item;
  }

  #checkRange(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.#length) {
      throw new RangeError(`position ${index} is outside the text (length ${this.#length})`);
    }
  }

  #seek(index: number): Seek {
    this.#checkRange(index);
    let before: Item | null = null;
    let offset = 0;
    let cur = this.#head.next;
    while (cur) {
      if (!cur.deleted) {
        if (offset === index) return { before, at: cur };
        offset += cur.content.length;
        if (offset > index) throw new RangeError(`position ${index} splits a surrogate pair`);
        before = cur;
      }
      cur = cur.next;
    }
    return { before, at: null };
  }
}
