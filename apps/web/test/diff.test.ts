import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applySplice, diffSplice } from '../src/editor/diff.js';

const isWellFormed = (s: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('diffSplice', () => {
  it('finds a single insertion, deletion or replacement', () => {
    expect(diffSplice('hello', 'help me')).toEqual({ index: 3, remove: 2, insert: 'p me' });
    expect(diffSplice('abc', 'abc')).toEqual({ index: 3, remove: 0, insert: '' });
    expect(diffSplice('', 'x')).toEqual({ index: 0, remove: 0, insert: 'x' });
    expect(diffSplice('abc', '')).toEqual({ index: 0, remove: 3, insert: '' });
  });

  it('uses the caret to place an insertion inside a run of equal characters', () => {
    expect(diffSplice('aa', 'aaa', 2)).toEqual({ index: 1, remove: 0, insert: 'a' });
    expect(diffSplice('aa', 'aaa', 1)).toEqual({ index: 0, remove: 0, insert: 'a' });
    expect(diffSplice('aaa', 'aa', 0)).toEqual({ index: 0, remove: 1, insert: '' });
  });

  it('never splits a surrogate pair', () => {
    // Same high surrogate, different low surrogate.
    const d = diffSplice('x\u{1F600}y', 'x\u{1F601}y');
    expect(d).toEqual({ index: 1, remove: 2, insert: '\u{1F601}' });
    const e = diffSplice('\u{1F600}', '\u{1F600}\u{1F600}');
    expect(isWellFormed(e.insert)).toBe(true);
  });

  const text = fc.string({
    unit: fc.constantFrom('a', 'b', '\u{1F600}', '\u{1F601}', 'é', ' '),
    maxLength: 12,
  });

  it('always reproduces the new text and keeps both sides well formed', () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const d = diffSplice(a, b);
        expect(applySplice(a, d)).toBe(b);
        expect(isWellFormed(d.insert)).toBe(true);
        expect(isWellFormed(a.slice(d.index, d.index + d.remove))).toBe(true);
      }),
    );
  });

  it('recovers the exact position of a typed insertion from the caret', () => {
    fc.assert(
      fc.property(
        text,
        fc.nat(),
        text.filter((s) => s.length > 0),
        (base, at, typed) => {
          const cps = Array.from(base);
          const k = at % (cps.length + 1);
          const index = cps.slice(0, k).join('').length;
          const next = base.slice(0, index) + typed + base.slice(index);
          const d = diffSplice(base, next, index + typed.length);
          expect(d).toEqual({ index, remove: 0, insert: typed });
        },
      ),
    );
  });
});
