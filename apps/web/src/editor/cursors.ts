import type { ReplicaId, TextType } from '@flock/crdt';
import type { Awareness } from '@flock/sync';
import { TextareaMeasurer } from './caret.js';
import { parsePresence } from './presence.js';

/**
 * Draws other participants' carets and selections over the textarea. Positions come from
 * awareness as relative positions, so each render resolves them against the current text.
 */
export class RemoteCursors {
  readonly #layer: HTMLElement;
  readonly #textarea: HTMLTextAreaElement;
  readonly #text: TextType;
  readonly #awareness: Awareness;
  readonly #measurer: TextareaMeasurer;
  readonly #off: Array<() => void> = [];
  #frame = 0;

  constructor(
    layer: HTMLElement,
    textarea: HTMLTextAreaElement,
    text: TextType,
    awareness: Awareness,
  ) {
    this.#layer = layer;
    this.#textarea = textarea;
    this.#text = text;
    this.#awareness = awareness;
    this.#measurer = new TextareaMeasurer(textarea);
    const schedule = (): void => {
      this.schedule();
    };
    this.#off.push(awareness.on('change', schedule));
    textarea.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    this.#off.push(() => {
      textarea.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    });
  }

  /** Re-renders on the next animation frame (coalesces bursts of changes). */
  schedule(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.render();
    });
  }

  render(): void {
    const scrollTop = this.#textarea.scrollTop;
    const scrollLeft = this.#textarea.scrollLeft;
    const fragment = document.createDocumentFragment();
    for (const [replica, state] of this.#awareness.getStates()) {
      if (replica === this.#awareness.replicaId) continue;
      const presence = parsePresence(state);
      if (!presence?.selection) continue;
      const anchor = this.#text.absolutePosition(presence.selection.anchor);
      const head = this.#text.absolutePosition(presence.selection.head);
      if (anchor === null || head === null) continue;
      const start = Math.min(anchor, head);
      const end = Math.max(anchor, head);
      const place = (
        el: HTMLElement,
        r: { left: number; top: number; width: number; height: number },
      ): void => {
        el.style.transform = `translate(${r.left - scrollLeft}px, ${r.top - scrollTop}px)`;
        el.style.height = `${r.height}px`;
        if (r.width) el.style.width = `${r.width}px`;
      };
      if (end > start) {
        for (const r of this.#measurer.rects(start, end)) {
          const hl = document.createElement('div');
          hl.className = 'remote-selection';
          hl.style.background = presence.color;
          place(hl, r);
          fragment.append(hl);
        }
      }
      const caretRect = this.#measurer.rects(head, head)[0];
      if (!caretRect) continue;
      const caret = document.createElement('div');
      caret.className = 'remote-caret';
      caret.style.setProperty('--peer', presence.color);
      caret.dataset['replica'] = replica satisfies ReplicaId;
      const label = document.createElement('span');
      label.className = 'remote-caret-label';
      label.textContent = presence.name;
      caret.append(label);
      place(caret, caretRect);
      fragment.append(caret);
    }
    this.#layer.replaceChildren(fragment);
  }

  destroy(): void {
    cancelAnimationFrame(this.#frame);
    for (const off of this.#off.splice(0)) off();
    this.#measurer.destroy();
    this.#layer.replaceChildren();
  }
}
