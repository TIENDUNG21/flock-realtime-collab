const COPIED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textIndent',
  'wordSpacing',
  'textTransform',
] as const;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Measures where text ranges of a <textarea> appear on screen, using an invisible mirror <div>
 * with the same font, padding and wrapping. Coordinates are relative to the textarea's
 * top-left corner, not counting its scroll offset.
 */
export class TextareaMeasurer {
  readonly #textarea: HTMLTextAreaElement;
  readonly #mirror: HTMLDivElement;

  constructor(textarea: HTMLTextAreaElement) {
    this.#textarea = textarea;
    this.#mirror = document.createElement('div');
    this.#mirror.setAttribute('aria-hidden', 'true');
    Object.assign(this.#mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      top: '0',
      left: '-9999px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      overflow: 'hidden',
    });
    document.body.appendChild(this.#mirror);
  }

  /** Line boxes covering `[start, end)`; a single caret box when start === end. */
  rects(start: number, end: number): Rect[] {
    const ta = this.#textarea;
    const style = getComputedStyle(ta);
    for (const prop of COPIED) this.#mirror.style[prop] = style[prop];
    this.#mirror.style.width = `${ta.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
    const value = ta.value;
    this.#mirror.textContent = '';
    this.#mirror.append(document.createTextNode(value.slice(0, start)));
    const mark = document.createElement('span');
    mark.textContent = start === end ? '​' : value.slice(start, end);
    this.#mirror.append(mark, document.createTextNode(value.slice(end) || '​'));
    const origin = this.#mirror.getBoundingClientRect();
    const rects = Array.from(mark.getClientRects(), (r) => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      width: start === end ? 0 : r.width,
      height: r.height,
    }));
    return rects.length > 0
      ? rects
      : [{ left: 0, top: 0, width: 0, height: parseFloat(style.lineHeight) || 20 }];
  }

  destroy(): void {
    this.#mirror.remove();
  }
}
