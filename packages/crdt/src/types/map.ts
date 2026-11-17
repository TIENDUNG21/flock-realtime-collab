import { freezeJson, type Json } from '../json.js';
import type { LwwMap } from '../lww-map.js';
import type { LocalOpSink } from './text.js';

/** Collaborative key-value map with last-writer-wins semantics per key. Values are JSON. */
export class MapType {
  readonly name: string;
  readonly #sink: LocalOpSink;
  readonly #entries: LwwMap<Json>;

  /** @internal Created by Doc.getMap. */
  constructor(name: string, sink: LocalOpSink, entries: LwwMap<Json>) {
    this.name = name;
    this.#sink = sink;
    this.#entries = entries;
  }

  /** Stores a deep, frozen copy of `value`. Throws TypeError for non-JSON values. */
  set(key: string, value: Json): void {
    if (typeof key !== 'string') throw new TypeError('map keys must be strings');
    const frozen = freezeJson(value);
    this.#sink.local(1, (id, lamport) => ({
      kind: 'set',
      id,
      lamport,
      target: this.name,
      key,
      value: frozen,
    }));
  }

  delete(key: string): void {
    if (!this.#entries.has(key)) return;
    this.#sink.local(1, (id, lamport) => ({
      kind: 'set',
      id,
      lamport,
      target: this.name,
      key,
      value: undefined,
    }));
  }

  get(key: string): Json | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  keys(): string[] {
    return this.#entries.keys();
  }

  get size(): number {
    return this.#entries.size;
  }

  entries(): IterableIterator<[string, Json]> {
    return this.#entries.entries();
  }

  toJSON(): Record<string, Json> {
    return this.#entries.toObject();
  }
}
