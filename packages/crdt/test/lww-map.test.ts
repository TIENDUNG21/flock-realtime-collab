import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LwwMap, type Stamp } from '@flock/crdt';

const s = (lamport: number, replica: string): Stamp => ({ lamport, replica });

interface Write {
  key: string;
  value: number | undefined;
  lamport: number;
  replica: string;
}

const run = (ops: readonly Write[]): LwwMap<number> => {
  const m = new LwwMap<number>();
  for (const w of ops) m.apply(w.key, w.value, s(w.lamport, w.replica));
  return m;
};

describe('LwwMap', () => {
  it('keeps the write with the highest stamp', () => {
    const m = new LwwMap<number>();
    expect(m.apply('k', 1, s(1, 'a'))).toBe(true);
    expect(m.apply('k', 2, s(3, 'a'))).toBe(true);
    expect(m.apply('k', 3, s(2, 'b'))).toBe(false);
    expect(m.get('k')).toBe(2);
  });

  it('breaks lamport ties by replica id', () => {
    const m = new LwwMap<string>();
    m.apply('k', 'from-b', s(4, 'b'));
    m.apply('k', 'from-a', s(4, 'a'));
    expect(m.get('k')).toBe('from-b');
  });

  it('treats undefined as a tombstone that a later set overwrites', () => {
    const m = new LwwMap<string>();
    m.apply('k', 'v', s(1, 'a'));
    m.apply('k', undefined, s(2, 'a'));
    expect(m.has('k')).toBe(false);
    expect(m.get('k')).toBeUndefined();
    expect(m.size).toBe(0);
    expect(m.stampOf('k')).toEqual(s(2, 'a'));
    m.apply('k', 'again', s(3, 'b'));
    expect(m.get('k')).toBe('again');
  });

  it('ignores a duplicate write with the same stamp', () => {
    const m = new LwwMap<number>();
    expect(m.apply('k', 1, s(1, 'a'))).toBe(true);
    expect(m.apply('k', 1, s(1, 'a'))).toBe(false);
  });

  it('lists live keys in sorted order and exports a plain object', () => {
    const m = new LwwMap<number>();
    m.apply('b', 2, s(1, 'a'));
    m.apply('a', 1, s(2, 'a'));
    m.apply('c', undefined, s(3, 'a'));
    expect(m.keys()).toEqual(['a', 'b']);
    expect(m.toObject()).toEqual({ a: 1, b: 2 });
    expect([...m.entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('stores keys like __proto__ as ordinary own keys', () => {
    const m = new LwwMap<number>();
    m.apply('__proto__', 1, s(1, 'a'));
    const obj = m.toObject();
    expect(Object.keys(obj)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  const write: fc.Arbitrary<Write> = fc.record({
    key: fc.constantFrom('x', 'y', 'z'),
    value: fc.option(fc.integer(), { nil: undefined }),
    lamport: fc.integer({ min: 1, max: 10 }),
    replica: fc.constantFrom('a', 'b', 'c'),
  });
  // Stamps are unique per write, as they are in a real system.
  const writes = fc.uniqueArray(write, {
    selector: (w) => `${w.lamport}:${w.replica}`,
    maxLength: 25,
  });

  it('converges for any delivery order (commutativity)', () => {
    fc.assert(
      fc.property(
        writes.chain((ws) =>
          fc.tuple(fc.constant(ws), fc.shuffledSubarray(ws, { minLength: ws.length })),
        ),
        ([ordered, shuffled]) => {
          expect(run(shuffled).toObject()).toEqual(run(ordered).toObject());
        },
      ),
    );
  });

  it('is idempotent under duplicate delivery', () => {
    fc.assert(
      fc.property(writes, (ws) => {
        expect(run([...ws, ...ws]).toObject()).toEqual(run(ws).toObject());
      }),
    );
  });
});
