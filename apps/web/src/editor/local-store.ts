import type { Doc } from '@flock/crdt';
import { fromBase64, toBase64 } from '../shared/base64.js';

/**
 * Local-first persistence: the full document state is kept in localStorage per room, so a
 * reload (or working with the server down) loses nothing. Writes are debounced.
 */
export class LocalStore {
  readonly #storage: Storage | null;
  readonly #key: string;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #off: (() => void) | undefined;

  constructor(storage: Storage | null, room: string) {
    this.#storage = storage;
    this.#key = `flock:room:${room}`;
  }

  /** Applies the saved state, if any. Returns false when nothing usable was stored. */
  load(doc: Doc): boolean {
    const saved = this.#read();
    if (!saved) return false;
    try {
      doc.applyUpdate(fromBase64(saved), 'local-store');
      return true;
    } catch (err) {
      console.warn('ignoring unreadable saved state', err);
      return false;
    }
  }

  /** Saves after every change (debounced). */
  attach(doc: Doc, delayMs = 300): void {
    this.#off?.();
    this.#off = doc.on('update', () => {
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.#write(toBase64(doc.encodeStateAsUpdate()));
      }, delayMs);
    });
  }

  clear(): void {
    try {
      this.#storage?.removeItem(this.#key);
    } catch {
      // storage unavailable: nothing to clear
    }
  }

  destroy(): void {
    clearTimeout(this.#timer);
    this.#off?.();
  }

  #read(): string | null {
    try {
      return this.#storage?.getItem(this.#key) ?? null;
    } catch {
      return null;
    }
  }

  #write(value: string): void {
    try {
      this.#storage?.setItem(this.#key, value);
    } catch (err) {
      console.warn('could not save to localStorage', err);
    }
  }
}
