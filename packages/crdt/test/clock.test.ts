import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LamportClock, VectorClock, compareStamps, idToString } from '@flock/crdt';

describe('compareStamps', () => {
  it('orders by lamport time first', () => {
    expect(compareStamps({ lamport: 1, replica: 'z' }, { lamport: 2, replica: 'a' })).toBeLessThan(
      0,
    );
    expect(
      compareStamps({ lamport: 3, replica: 'a' }, { lamport: 2, replica: 'z' }),
    ).toBeGreaterThan(0);
  });

  it('breaks ties by replica id', () => {
    expect(compareStamps({ lamport: 5, replica: 'a' }, { lamport: 5, replica: 'b' })).toBeLessThan(
      0,
    );
    expect(compareStamps({ lamport: 5, replica: 'b' }, { lamport: 5, replica: 'b' })).toBe(0);
  });

  it('is a total order (antisymmetric and transitive)', () => {
    const stamp = fc.record({
      lamport: fc.nat(20),
      replica: fc.constantFrom('a', 'b', 'c', 'ab'),
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, (a, b, c) => {
        expect(Math.sign(compareStamps(a, b))).toBe(-Math.sign(compareStamps(b, a)) || 0);
        if (compareStamps(a, b) <= 0 && compareStamps(b, c) <= 0) {
          expect(compareStamps(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('idToString', () => {
  it('formats replica and sequence number', () => {
    expect(idToString({ replica: 'alice', seq: 7 })).toBe('alice@7');
  });
});

describe('LamportClock', () => {
  it('ticks monotonically and reserves ranges', () => {
    const clock = new LamportClock();
    expect(clock.now).toBe(0);
    expect(clock.tick()).toBe(1);
    expect(clock.tick(3)).toBe(2);
    expect(clock.now).toBe(4);
  });

  it('jumps forward when observing a later remote time', () => {
    const clock = new LamportClock(2);
    clock.observe(10);
    expect(clock.now).toBe(10);
    clock.observe(4);
    expect(clock.now).toBe(10);
    expect(clock.tick()).toBe(11);
  });

  it('rejects invalid tick sizes and start values', () => {
    expect(() => new LamportClock().tick(0)).toThrow(RangeError);
    expect(() => new LamportClock().tick(1.5)).toThrow(RangeError);
    expect(() => new LamportClock(-1)).toThrow(RangeError);
  });
});

describe('VectorClock', () => {
  it('starts empty and reads missing replicas as zero', () => {
    const v = new VectorClock();
    expect(v.get('a')).toBe(0);
    expect(v.size).toBe(0);
  });

  it('increments and covers ids', () => {
    const v = new VectorClock();
    expect(v.increment('a')).toBe(1);
    expect(v.increment('a')).toBe(2);
    expect(v.covers({ replica: 'a', seq: 2 })).toBe(true);
    expect(v.covers({ replica: 'a', seq: 3 })).toBe(false);
    expect(v.covers({ replica: 'b', seq: 1 })).toBe(false);
  });

  it('compares causally', () => {
    const a = VectorClock.from({ x: 1, y: 2 });
    expect(a.compare(VectorClock.from({ x: 1, y: 2 }))).toBe('equal');
    expect(a.compare(VectorClock.from({ x: 2, y: 2 }))).toBe('before');
    expect(a.compare(VectorClock.from({ x: 1 }))).toBe('after');
    expect(a.compare(VectorClock.from({ x: 2, y: 1 }))).toBe('concurrent');
    expect(new VectorClock().compare(VectorClock.from({ z: 0 }))).toBe('equal');
  });

  it('rejects negative or fractional entries', () => {
    expect(() => VectorClock.from({ a: -1 })).toThrow(RangeError);
    expect(() => {
      new VectorClock().set('a', 0.5);
    }).toThrow(RangeError);
  });

  it('lists entries sorted by replica, without zero entries', () => {
    const v = VectorClock.from({ b: 2, a: 1, c: 0 });
    expect(v.entries()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(v.toJSON()).toEqual({ a: 1, b: 2 });
  });

  const clock = fc
    .dictionary(fc.constantFrom('a', 'b', 'c', 'd'), fc.nat(5))
    .map((d) => VectorClock.from(d));

  it('merge is commutative, associative and idempotent', () => {
    fc.assert(
      fc.property(clock, clock, clock, (a, b, c) => {
        expect(a.merge(b).equals(b.merge(a))).toBe(true);
        expect(
          a
            .merge(b)
            .merge(c)
            .equals(a.merge(b.merge(c))),
        ).toBe(true);
        expect(a.merge(a).equals(a)).toBe(true);
      }),
    );
  });

  it('merge dominates both inputs and compare is mirror-consistent', () => {
    const mirror = {
      before: 'after',
      after: 'before',
      equal: 'equal',
      concurrent: 'concurrent',
    } as const;
    fc.assert(
      fc.property(clock, clock, (a, b) => {
        const m = a.merge(b);
        expect(['after', 'equal']).toContain(m.compare(a));
        expect(['after', 'equal']).toContain(m.compare(b));
        expect(b.compare(a)).toBe(mirror[a.compare(b)]);
      }),
    );
  });
});
