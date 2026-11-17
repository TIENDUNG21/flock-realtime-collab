import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, type Json, type Op } from '@flock/crdt';

/** Small deterministic PRNG so delivery order is reproducible from the fast-check seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Step =
  | { t: 'ins'; r: number; pos: number; text: string }
  | { t: 'del'; r: number; pos: number; len: number }
  | { t: 'set'; r: number; key: string; value: Json }
  | { t: 'unset'; r: number; key: string }
  | { t: 'deliver'; from: number; to: number; count: number; dup: boolean };

const chars = fc.constantFrom(
  'a',
  'b',
  'c',
  ' ',
  '\n',
  'é',
  'ữ',
  '\u{1F600}',
  '\u{1F44D}\u{1F3FD}',
  'é',
);
const text = fc.array(chars, { minLength: 1, maxLength: 4 }).map((parts) => parts.join(''));
const key = fc.constantFrom('x', 'y', 'z');
const value: fc.Arbitrary<Json> = fc.oneof(
  fc.integer(),
  fc.string({ maxLength: 4 }),
  fc.constant(null),
  fc.record({ w: fc.nat(100), tags: fc.array(fc.boolean(), { maxLength: 2 }) }),
);

const step = (replicas: number): fc.Arbitrary<Step> => {
  const r = fc.nat(replicas - 1);
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant('ins' as const),
        r,
        pos: fc.double({ min: 0, max: 1, noNaN: true }),
        text,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        t: fc.constant('del' as const),
        r,
        pos: fc.double({ min: 0, max: 1, noNaN: true }),
        len: fc.integer({ min: 1, max: 4 }),
      }),
    },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('set' as const), r, key, value }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('unset' as const), r, key }) },
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant('deliver' as const),
        from: r,
        to: r,
        count: fc.integer({ min: 1, max: 6 }),
        dup: fc.boolean(),
      }),
    },
  );
};

const scenario = fc.integer({ min: 3, max: 5 }).chain((replicas) =>
  fc.record({
    replicas: fc.constant(replicas),
    steps: fc.array(step(replicas), { maxLength: 60 }),
    seed: fc.integer(),
  }),
);

/** Moves an offset left until it no longer splits a surrogate pair. */
function snap(s: string, index: number): number {
  let i = Math.max(0, Math.min(index, s.length));
  const c = s.charCodeAt(i);
  if (i > 0 && i < s.length && c >= 0xdc00 && c <= 0xdfff) i--;
  return i;
}

interface Run {
  docs: Doc[];
  produced: Op[][];
}

/**
 * Runs a scenario: every local op is queued on a channel to every other replica; `deliver`
 * steps hand over random messages from one channel (out of order, sometimes duplicated);
 * at the end every channel is flushed in random order with extra duplicates.
 */
function play(replicas: number, steps: readonly Step[], seed: number): Run {
  const random = mulberry32(seed);
  const docs = Array.from({ length: replicas }, (_, i) => new Doc({ replicaId: `r${i}` }));
  const produced: Op[][] = docs.map(() => []);
  const channels = new Map<string, Op[]>();
  const channel = (from: number, to: number): Op[] => {
    const k = `${from}>${to}`;
    let q = channels.get(k);
    if (!q) channels.set(k, (q = []));
    return q;
  };
  docs.forEach((doc, i) => {
    doc.on('update', (e) => {
      if (!e.local) return;
      produced[i]?.push(...e.ops);
      for (let j = 0; j < replicas; j++) if (j !== i) channel(i, j).push(...e.ops);
    });
  });

  const deliver = (from: number, to: number, count: number, dup: boolean): void => {
    const q = channel(from, to);
    for (let n = 0; n < count && q.length > 0; n++) {
      const idx = Math.floor(random() * q.length);
      const op = q[idx];
      if (!op) continue;
      if (!dup) q.splice(idx, 1);
      docs[to]?.applyOps([op], from);
    }
  };

  for (const s of steps) {
    if (s.t === 'deliver') {
      if (s.from !== s.to) deliver(s.from, s.to, s.count, s.dup);
      continue;
    }
    const doc = docs[s.r];
    if (!doc) continue;
    const t = doc.getText('text');
    const m = doc.getMap('map');
    const str = t.toString();
    if (s.t === 'ins') {
      t.insert(snap(str, Math.floor(s.pos * (str.length + 1))), s.text);
    } else if (s.t === 'del' && str.length > 0) {
      const start = snap(str, Math.floor(s.pos * str.length));
      const end = snap(str, Math.min(str.length, start + s.len));
      if (end > start) t.delete(start, end - start);
    } else if (s.t === 'set') {
      m.set(s.key, s.value);
    } else if (s.t === 'unset') {
      m.delete(s.key);
    }
  }

  // Flush: every channel, random order, with duplicates of some messages.
  const keys = [...channels.keys()];
  while (keys.some((k) => (channels.get(k)?.length ?? 0) > 0)) {
    const k = keys[Math.floor(random() * keys.length)] ?? '';
    const [from, to] = k.split('>').map(Number) as [number, number];
    deliver(from, to, 3, random() < 0.2);
  }
  return { docs, produced };
}

const states = (docs: readonly Doc[]): unknown[] => docs.map((d) => d.debugState());

describe('convergence (property-based)', () => {
  it('replicas end identical after random concurrent edits and out-of-order, duplicated delivery', () => {
    fc.assert(
      fc.property(scenario, ({ replicas, steps, seed }) => {
        const { docs } = play(replicas, steps, seed);
        const [first, ...rest] = states(docs);
        for (const other of rest) expect(other).toEqual(first);
        for (const doc of docs) expect(doc.pendingCount).toBe(0);
      }),
      { numRuns: 250 },
    );
  });

  it('re-applying every operation again changes nothing (idempotence)', () => {
    fc.assert(
      fc.property(scenario, ({ replicas, steps, seed }) => {
        const { docs, produced } = play(replicas, steps, seed);
        const before = states(docs);
        let events = 0;
        for (const doc of docs) {
          doc.on('update', () => {
            events++;
          });
          for (const ops of produced) doc.applyOps([...ops].reverse());
        }
        expect(states(docs)).toEqual(before);
        expect(events).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('merging histories gives the same state in either order (commutativity)', () => {
    fc.assert(
      fc.property(scenario, fc.integer(), ({ replicas, steps, seed }, splitSeed) => {
        // Diverge the replicas without any delivery, then merge pairs in both orders.
        const local = steps.filter((s) => s.t !== 'deliver');
        const { produced } = play(replicas, local, seed);
        const random = mulberry32(splitSeed);
        const i = Math.floor(random() * replicas);
        const j = (i + 1 + Math.floor(random() * (replicas - 1))) % replicas;
        const ab = new Doc({ replicaId: 'm1' });
        ab.applyOps(produced[i] ?? []);
        ab.applyOps(produced[j] ?? []);
        const ba = new Doc({ replicaId: 'm2' });
        ba.applyOps(produced[j] ?? []);
        ba.applyOps(produced[i] ?? []);
        expect(ba.debugState()).toEqual(ab.debugState());
        // Merging everything in one batch equals merging pairwise.
        const all = new Doc({ replicaId: 'm3' });
        all.applyOps(produced.flat().reverse());
        const seq = new Doc({ replicaId: 'm4' });
        for (const ops of produced) seq.applyOps(ops);
        expect(all.debugState()).toEqual(seq.debugState());
      }),
      { numRuns: 150 },
    );
  });

  it('a single replica behaves exactly like a plain string', () => {
    const edit = fc.oneof(
      fc.record({
        ins: fc.constant(true as const),
        pos: fc.double({ min: 0, max: 1, noNaN: true }),
        text,
      }),
      fc.record({
        ins: fc.constant(false as const),
        pos: fc.double({ min: 0, max: 1, noNaN: true }),
        len: fc.integer({ min: 1, max: 5 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 80 }), (edits) => {
        const t = new Doc({ replicaId: 'solo' }).getText('t');
        let model = '';
        for (const e of edits) {
          if (e.ins) {
            const at = snap(model, Math.floor(e.pos * (model.length + 1)));
            t.insert(at, e.text);
            model = model.slice(0, at) + e.text + model.slice(at);
          } else if (model.length > 0) {
            const start = snap(model, Math.floor(e.pos * model.length));
            const end = snap(model, Math.min(model.length, start + e.len));
            if (end > start) {
              t.delete(start, end - start);
              model = model.slice(0, start) + model.slice(end);
            }
          }
          expect(t.toString()).toBe(model);
          expect(t.length).toBe(model.length);
        }
      }),
      { numRuns: 200 },
    );
  });
});
