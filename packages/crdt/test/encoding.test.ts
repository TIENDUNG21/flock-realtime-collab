import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  Doc,
  Reader,
  VectorClock,
  Writer,
  decodeStateVector,
  decodeUpdate,
  encodeStateVector,
  encodeUpdate,
  mergeUpdates,
  readJson,
  writeJson,
  type Json,
  type Op,
} from '@flock/crdt';

const roundTripVarUint = (n: number): number => {
  const w = new Writer();
  w.varUint(n);
  const r = new Reader(w.finish());
  const out = r.varUint();
  expect(r.done).toBe(true);
  return out;
};

describe('Writer and Reader', () => {
  it('round-trips unsigned varints up to 2^53 - 1', () => {
    for (const n of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) {
      expect(roundTripVarUint(n)).toBe(n);
    }
    fc.assert(fc.property(fc.maxSafeNat(), (n) => roundTripVarUint(n) === n));
  });

  it('uses one byte for values below 128', () => {
    const w = new Writer();
    w.varUint(127);
    expect(w.finish()).toHaveLength(1);
  });

  it('round-trips signed varints, floats and strings', () => {
    fc.assert(
      fc.property(fc.maxSafeInteger(), fc.double(), fc.string({ unit: 'binary' }), (i, f, s) => {
        const w = new Writer();
        w.varInt(i);
        w.f64(f);
        w.string(s);
        const r = new Reader(w.finish());
        expect(r.varInt()).toBe(i);
        expect(Object.is(r.f64(), f)).toBe(true);
        expect(r.string()).toBe(s);
        expect(r.done).toBe(true);
      }),
    );
  });

  it('rejects writing invalid numbers and lone surrogates', () => {
    const w = new Writer();
    expect(() => {
      w.varUint(-1);
    }).toThrow(RangeError);
    expect(() => {
      w.varUint(2 ** 53);
    }).toThrow(RangeError);
    expect(() => {
      w.string('\uD800x');
    }).toThrow(TypeError);
  });

  it('reports truncation with the byte offset', () => {
    const r = new Reader(Uint8Array.of(0x80, 0x80));
    expect(() => r.varUint()).toThrow(DecodeError);
    const truncated = new Reader(Uint8Array.of(0x00, 0x05, 0x61));
    truncated.u8();
    expect(() => truncated.string()).toThrow(
      expect.objectContaining({ name: 'DecodeError', offset: 1 }),
    );
  });

  it('rejects overlong varints and invalid UTF-8', () => {
    expect(() => new Reader(new Uint8Array(9).fill(0xff)).varUint()).toThrow(DecodeError);
    for (const bad of [
      [0x01, 0xff],
      [0x02, 0xc0, 0x80], // overlong encoding of NUL
      [0x03, 0xed, 0xa0, 0x80], // encoded surrogate
      [0x02, 0xe2, 0x82], // truncated sequence
      [0x04, 0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
    ]) {
      expect(() => new Reader(Uint8Array.from(bad)).string()).toThrow(DecodeError);
    }
  });
});

describe('JSON values', () => {
  const roundTrip = (value: Json): Json => {
    const w = new Writer();
    writeJson(w, value);
    return readJson(new Reader(w.finish()));
  };

  it('round-trips arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(roundTrip(value as Json)).toEqual(value);
      }),
    );
  });

  it('keeps -0 and fractional numbers exact', () => {
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(roundTrip(0.1)).toBe(0.1);
    expect(roundTrip(2 ** 60)).toBe(2 ** 60);
  });

  it('rejects nesting deeper than the limit and unknown tags', () => {
    const deep = new Uint8Array(200).fill(6); // array tag repeated: [[[[...
    expect(() => readJson(new Reader(deep))).toThrow(DecodeError);
    expect(() => readJson(new Reader(Uint8Array.of(99)))).toThrow(DecodeError);
  });

  it('rejects collection sizes larger than the remaining input', () => {
    const w = new Writer();
    w.u8(6);
    w.varUint(1_000_000_000);
    expect(() => readJson(new Reader(w.finish()))).toThrow(/exceeds/);
  });
});

function sampleOps(): Op[] {
  const a = new Doc({ replicaId: 'alice' });
  const b = new Doc({ replicaId: 'bob' });
  const ops: Op[] = [];
  for (const d of [a, b]) d.on('update', (e) => ops.push(...(e.local ? e.ops : [])));
  a.getText('t').insert(0, 'hello \u{1F600}');
  b.applyOps(a.opsSince(b.stateVector()));
  b.getText('t').insert(6, 'big ');
  a.getText('t').delete(0, 1);
  a.getMap('m').set('k', { x: [1, 2.5, 'three'], ok: true });
  a.getMap('m').delete('k');
  b.getMap('m').set('n', null);
  return ops;
}

describe('update encoding', () => {
  it('round-trips operations exactly', () => {
    const ops = sampleOps();
    expect(decodeUpdate(encodeUpdate(ops))).toEqual(
      [...ops].sort((x, y) =>
        x.id.replica < y.id.replica ? -1 : x.id.replica > y.id.replica ? 1 : x.id.seq - y.id.seq,
      ),
    );
  });

  it('encodes an empty update in a few bytes', () => {
    expect(encodeUpdate([]).length).toBeLessThanOrEqual(3);
    expect(decodeUpdate(encodeUpdate([]))).toEqual([]);
  });

  it('is much smaller than JSON for a typing trace', () => {
    const doc = new Doc({ replicaId: 'typist-0001' });
    const ops: Op[] = [];
    doc.on('update', (e) => ops.push(...e.ops));
    const text = doc.getText('body');
    for (let i = 0; i < 500; i++) text.insert(i, String.fromCharCode(97 + (i % 26)));
    const binary = encodeUpdate(ops).length;
    expect(binary).toBeLessThan(JSON.stringify(ops).length / 10);
    expect(binary / ops.length).toBeLessThan(4);
  });

  it('lets a fresh doc rebuild the state from encodeStateAsUpdate', () => {
    const a = new Doc({ replicaId: 'a' });
    a.getText('t').insert(0, 'abc');
    a.getMap('m').set('x', 1);
    const b = new Doc({ replicaId: 'b' });
    b.applyUpdate(a.encodeStateAsUpdate());
    expect(b.debugState()).toEqual(a.debugState());
    a.getText('t').insert(3, 'def');
    const delta = a.encodeStateAsUpdate(b.stateVector());
    expect(decodeUpdate(delta)).toHaveLength(1);
    b.applyUpdate(delta);
    expect(b.getText('t').toString()).toBe('abcdef');
  });

  it('exposes the encoded update on update events', () => {
    const a = new Doc({ replicaId: 'a' });
    const b = new Doc({ replicaId: 'b' });
    a.on('update', (e) => {
      b.applyUpdate(e.update, 'a');
    });
    a.getText('t').insert(0, 'live');
    expect(b.getText('t').toString()).toBe('live');
  });

  it('merges updates into one deduplicated update', () => {
    const a = new Doc({ replicaId: 'a' });
    const updates: Uint8Array[] = [];
    a.on('update', (e) => updates.push(e.update));
    a.getText('t').insert(0, 'one');
    a.getText('t').insert(3, ' two');
    a.getMap('m').set('k', 'v');
    const merged = mergeUpdates([...updates, ...updates]);
    expect(decodeUpdate(merged)).toHaveLength(3);
    const b = new Doc({ replicaId: 'b' });
    b.applyUpdate(merged);
    expect(b.debugState()).toEqual(a.debugState());
  });

  it('round-trips state vectors', () => {
    const sv = VectorClock.from({ alice: 12, bob: 3, 'carol-\u{1F600}': 2 ** 40 });
    expect(decodeStateVector(encodeStateVector(sv)).toJSON()).toEqual(sv.toJSON());
  });
});

describe('malformed updates', () => {
  const valid = encodeUpdate(sampleOps());

  it('rejects an unknown format version', () => {
    const bad = valid.slice();
    bad[0] = 9;
    expect(() => decodeUpdate(bad)).toThrow(/version/);
  });

  it('throws DecodeError (never anything else) for every truncation', () => {
    for (let end = 0; end < valid.length; end++) {
      expect(() => decodeUpdate(valid.subarray(0, end)), `prefix ${end}`).toThrow(DecodeError);
    }
  });

  it('rejects trailing bytes', () => {
    const bad = new Uint8Array(valid.length + 1);
    bad.set(valid);
    expect(() => decodeUpdate(bad)).toThrow(/trailing/);
  });

  it('never crashes with anything but DecodeError on random or mutated input', () => {
    const mutated = fc
      .tuple(fc.nat(valid.length - 1), fc.integer({ min: 0, max: 255 }))
      .map(([i, b]) => {
        const copy = valid.slice();
        copy[i] = b;
        return copy;
      });
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 64 }), mutated), (bytes) => {
        try {
          decodeUpdate(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('rejects references to strings outside the table', () => {
    const w = new Writer();
    w.u8(1); // version
    w.varUint(0); // empty string table
    w.varUint(1); // one group
    w.varUint(3); // replica index 3: out of range
    expect(() => decodeUpdate(w.finish())).toThrow(DecodeError);
  });

  it('leaves the document untouched when applyUpdate gets garbage', () => {
    const doc = new Doc({ replicaId: 'a' });
    doc.getText('t').insert(0, 'safe');
    expect(() => {
      doc.applyUpdate(Uint8Array.of(1, 2, 3));
    }).toThrow(DecodeError);
    expect(doc.getText('t').toString()).toBe('safe');
  });
});
