import type { Doc, RelativePosition, TextType } from '@flock/crdt';
import { diffSplice } from './diff.js';

export interface RelativeSelection {
  readonly anchor: RelativePosition;
  readonly head: RelativePosition;
}

/**
 * Two-way binding between a <textarea> and a shared text.
 *
 * Local input is turned into one splice (diff of the old and new value, disambiguated by the
 * caret) and applied as CRDT operations. Remote changes replace the value; the local selection
 * is kept as relative positions (anchored to character ids), so it stays on the same characters
 * even when text is inserted or deleted before it.
 */
export class TextAreaBinding {
  readonly #textarea: HTMLTextAreaElement;
  readonly #text: TextType;
  readonly #doc: Doc;
  readonly #listeners: Array<() => void> = [];
  readonly #onSelection: (selection: RelativeSelection | null) => void;
  #value: string;
  #selection: RelativeSelection | null = null;

  constructor(
    textarea: HTMLTextAreaElement,
    text: TextType,
    doc: Doc,
    onSelection: (selection: RelativeSelection | null) => void = () => undefined,
  ) {
    this.#textarea = textarea;
    this.#text = text;
    this.#doc = doc;
    this.#onSelection = onSelection;
    this.#value = text.toString();
    textarea.value = this.#value;

    const listen = (type: string, fn: () => void): void => {
      textarea.addEventListener(type, fn);
      this.#listeners.push(() => {
        textarea.removeEventListener(type, fn);
      });
    };
    listen('input', () => {
      this.#onInput();
    });
    for (const type of ['select', 'keyup', 'mouseup', 'focus'] as const) {
      listen(type, () => {
        this.#captureSelection();
      });
    }
    listen('blur', () => {
      this.#selection = null;
      this.#onSelection(null);
    });
    const onSelectionChange = (): void => {
      if (document.activeElement === textarea) this.#captureSelection();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    this.#listeners.push(() => {
      document.removeEventListener('selectionchange', onSelectionChange);
    });
    this.#listeners.push(
      doc.on('change', (event) => {
        // Anything not typed into this textarea (remote edits, programmatic local edits).
        if (event.targets.has(text.name) && this.#textarea.value !== text.toString()) {
          this.#onRemote();
        }
      }),
    );
  }

  destroy(): void {
    for (const off of this.#listeners.splice(0)) off();
  }

  #onInput(): void {
    const next = this.#textarea.value;
    const splice = diffSplice(this.#value, next, this.#textarea.selectionEnd);
    this.#doc.transact(() => {
      if (splice.remove > 0) this.#text.delete(splice.index, splice.remove);
      if (splice.insert.length > 0) this.#text.insert(splice.index, splice.insert);
    });
    this.#value = next;
    this.#captureSelection();
  }

  #onRemote(): void {
    const ta = this.#textarea;
    const focused = document.activeElement === ta;
    const selection = this.#selection;
    const scrollTop = ta.scrollTop;
    this.#value = this.#text.toString();
    ta.value = this.#value;
    ta.scrollTop = scrollTop;
    if (focused && selection) {
      const anchor = this.#text.absolutePosition(selection.anchor) ?? ta.value.length;
      const head = this.#text.absolutePosition(selection.head) ?? ta.value.length;
      const backward = head < anchor;
      ta.setSelectionRange(
        Math.min(anchor, head),
        Math.max(anchor, head),
        backward ? 'backward' : 'forward',
      );
    }
  }

  #captureSelection(): void {
    const ta = this.#textarea;
    const { selectionStart: start, selectionEnd: end } = ta;
    try {
      // A caret sticks to the character before it; a range spans its first and last character.
      const startPos = this.#text.relativePosition(start, start === end ? 'left' : 'right');
      const endPos = this.#text.relativePosition(end, 'left');
      this.#selection =
        ta.selectionDirection === 'backward'
          ? { anchor: endPos, head: startPos }
          : { anchor: startPos, head: endPos };
    } catch {
      this.#selection = null; // the textarea and the document are briefly out of step
    }
    this.#onSelection(this.#selection);
  }
}
