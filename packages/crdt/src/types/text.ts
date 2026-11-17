import type { Id } from '../id.js';
import type { Op } from '../ops.js';
import { codePointCount, isWellFormed } from '../text/codepoints.js';
import type { Rga } from '../text/rga.js';

/** The part of Doc that shared types use to create local operations. */
export interface LocalOpSink {
  /** Assigns the next id and Lamport time, then integrates and records the operation. */
  local(length: number, build: (id: Id, lamport: number) => Op): void;
}

/**
 * A position that survives concurrent edits. It is anchored to a character id rather than to an
 * offset: `side: 'right'` sticks to the character after the position (`null` = end of text),
 * `side: 'left'` to the character before it (`null` = start of text).
 */
export interface RelativePosition {
  readonly anchor: Id | null;
  readonly side: 'left' | 'right';
}

/** Collaborative plain text. Offsets are UTF-16 code units, like JavaScript strings. */
export class TextType {
  readonly name: string;
  readonly #sink: LocalOpSink;
  readonly #rga: Rga;

  /** @internal Created by Doc.getText. */
  constructor(name: string, sink: LocalOpSink, rga: Rga) {
    this.name = name;
    this.#sink = sink;
    this.#rga = rga;
  }

  get length(): number {
    return this.#rga.length;
  }

  toString(): string {
    return this.#rga.toString();
  }

  toJSON(): string {
    return this.toString();
  }

  insert(index: number, text: string): void {
    if (typeof text !== 'string' || !isWellFormed(text)) {
      throw new TypeError('inserted text must be a string without lone surrogates');
    }
    const origin = this.#rga.originAt(index);
    if (text.length === 0) return;
    this.#sink.local(codePointCount(text), (id, lamport) => ({
      kind: 'ins',
      id,
      lamport,
      target: this.name,
      origin,
      content: text,
    }));
  }

  delete(index: number, length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`delete length must be a non-negative integer, got ${length}`);
    }
    const ranges = this.#rga.rangesAt(index, length);
    if (ranges.length === 0) return;
    this.#sink.local(1, (id, lamport) => ({ kind: 'del', id, lamport, target: this.name, ranges }));
  }

  relativePosition(index: number, side: 'left' | 'right' = 'right'): RelativePosition {
    const item = side === 'right' ? this.#rga.itemAt(index) : this.#rga.itemBefore(index);
    return { anchor: item ? { replica: item.replica, seq: item.seq } : null, side };
  }

  /** Current offset of a relative position, or null if its anchor is unknown here. */
  absolutePosition(position: RelativePosition): number | null {
    if (position.anchor === null) return position.side === 'right' ? this.length : 0;
    const item = this.#rga.find(position.anchor);
    if (!item) return null;
    const offset = this.#rga.offsetOf(item);
    return position.side === 'left' && !item.deleted ? offset + item.content.length : offset;
  }
}
