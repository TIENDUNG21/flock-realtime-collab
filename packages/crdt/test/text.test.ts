import { describe, expect, it } from 'vitest';
import { Doc } from '@flock/crdt';
import { pull, syncAll } from './helpers.js';

const make = (replicaId: string, initial = ''): Doc => {
  const doc = new Doc({ replicaId });
  if (initial) doc.getText('t').insert(0, initial);
  return doc;
};

describe('TextType local editing', () => {
  it('inserts at the start, middle and end', () => {
    const text = make('a').getText('t');
    text.insert(0, 'hlo');
    text.insert(1, 'el');
    text.insert(5, '!');
    text.insert(0, '>');
    expect(text.toString()).toBe('>hello!');
    expect(text.length).toBe(7);
  });

  it('deletes ranges and keeps tombstones out of the visible text', () => {
    const text = make('a', 'hello world').getText('t');
    text.delete(5, 6);
    expect(text.toString()).toBe('hello');
    text.delete(0, 1);
    expect(text.toString()).toBe('ello');
    text.insert(4, ' there');
    expect(text.toString()).toBe('ello there');
  });

  it('treats empty inserts and zero-length deletes as no-ops', () => {
    const doc = make('a', 'ab');
    const before = doc.stateVector().get('a');
    doc.getText('t').insert(1, '');
    doc.getText('t').delete(1, 0);
    expect(doc.stateVector().get('a')).toBe(before);
  });

  it('rejects out-of-range positions', () => {
    const text = make('a', 'abc').getText('t');
    expect(() => {
      text.insert(4, 'x');
    }).toThrow(RangeError);
    expect(() => {
      text.insert(-1, 'x');
    }).toThrow(RangeError);
    expect(() => {
      text.delete(2, 2);
    }).toThrow(RangeError);
    expect(() => {
      text.insert(1.5, 'x');
    }).toThrow(RangeError);
  });

  it('stores astral characters as single items and never splits them', () => {
    const text = make('a').getText('t');
    text.insert(0, 'a\u{1F600}b');
    expect(text.length).toBe(4);
    expect(() => {
      text.insert(2, 'x');
    }).toThrow(RangeError);
    expect(() => {
      text.delete(2, 1);
    }).toThrow(RangeError);
    text.delete(1, 2);
    expect(text.toString()).toBe('ab');
  });

  it('rejects strings with lone surrogates', () => {
    const text = make('a').getText('t');
    expect(() => {
      text.insert(0, '\uD83D');
    }).toThrow(TypeError);
  });
});

describe('TextType concurrent editing', () => {
  it('orders concurrent inserts at the same position deterministically', () => {
    const a = make('a', 'ab');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    a.getText('t').insert(1, 'X');
    b.getText('t').insert(1, 'Y');
    syncAll(a, b);
    // Equal Lamport times: the higher replica id goes first.
    expect(a.getText('t').toString()).toBe('aYXb');
    expect(b.getText('t').toString()).toBe('aYXb');
  });

  it('does not interleave two concurrently typed words', () => {
    const a = make('a', '[]');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    a.getText('t').insert(1, 'left');
    b.getText('t').insert(1, 'right');
    syncAll(a, b);
    expect(a.getText('t').toString()).toBe('[rightleft]');
    expect(b.getText('t').toString()).toBe(a.getText('t').toString());
  });

  it('keeps an insertion made next to a concurrently deleted character', () => {
    const a = make('a', 'abc');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    a.getText('t').delete(1, 1);
    b.getText('t').insert(2, 'X');
    syncAll(a, b);
    expect(a.getText('t').toString()).toBe('aXc');
    expect(b.getText('t').toString()).toBe('aXc');
  });

  it('applies concurrent deletes of the same character once', () => {
    const a = make('a', 'abc');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    a.getText('t').delete(0, 2);
    b.getText('t').delete(1, 2);
    syncAll(a, b);
    expect(a.getText('t').toString()).toBe('');
    expect(b.getText('t').length).toBe(0);
  });

  it('places later local inserts after their causal predecessors', () => {
    const a = make('a', 'x');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    b.getText('t').insert(1, 'y');
    pull(a, b);
    a.getText('t').insert(2, 'z');
    pull(b, a);
    expect(b.getText('t').toString()).toBe('xyz');
  });
});

describe('relative positions', () => {
  it('follow their character when text is inserted before them', () => {
    const a = make('a', 'abcd');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    const cursor = a.getText('t').relativePosition(2);
    b.getText('t').insert(0, 'XY');
    pull(a, b);
    expect(a.getText('t').absolutePosition(cursor)).toBe(4);
  });

  it('stay at the gap when their anchor character is deleted', () => {
    const doc = make('a', 'abcd');
    const text = doc.getText('t');
    const cursor = text.relativePosition(2);
    text.delete(1, 2);
    expect(text.toString()).toBe('ad');
    expect(text.absolutePosition(cursor)).toBe(1);
  });

  it('anchor to the left character with side "left"', () => {
    const a = make('a', 'ab');
    const b = new Doc({ replicaId: 'b' });
    pull(b, a);
    const left = a.getText('t').relativePosition(1, 'left');
    const right = a.getText('t').relativePosition(1, 'right');
    b.getText('t').insert(1, 'XYZ');
    pull(a, b);
    expect(a.getText('t').absolutePosition(left)).toBe(1);
    expect(a.getText('t').absolutePosition(right)).toBe(4);
  });

  it('handle the start and end of the text', () => {
    const text = make('a', 'abc').getText('t');
    const start = text.relativePosition(0, 'left');
    const end = text.relativePosition(3, 'right');
    text.insert(3, 'def');
    text.insert(0, '>');
    expect(text.absolutePosition(start)).toBe(0);
    expect(text.absolutePosition(end)).toBe(7);
  });

  it('return null for anchors this replica has never seen', () => {
    const a = make('a', 'abc');
    const b = make('b', 'xyz');
    const foreign = b.getText('t').relativePosition(1);
    expect(a.getText('t').absolutePosition(foreign)).toBeNull();
  });
});
