import { describe, expect, it } from 'vitest';
import { Doc, InvalidOpError, VectorClock, type Op, type UpdateEvent } from '@flock/crdt';
import { pull, recordOps } from './helpers.js';

describe('Doc state vector and history', () => {
  it('advances the state vector by one unit per character and per map write', () => {
    const doc = new Doc({ replicaId: 'a' });
    doc.getText('t').insert(0, 'abc');
    expect(doc.stateVector().get('a')).toBe(3);
    doc.getMap('m').set('k', 1);
    doc.getText('t').delete(0, 2);
    expect(doc.stateVector().toJSON()).toEqual({ a: 5 });
  });

  it('returns only the history a peer is missing', () => {
    const doc = new Doc({ replicaId: 'a' });
    doc.getText('t').insert(0, 'ab');
    doc.getText('t').insert(2, 'cd');
    doc.getMap('m').set('x', true);
    expect(doc.opsSince(new VectorClock())).toHaveLength(3);
    expect(doc.opsSince(VectorClock.from({ a: 2 })).map((op) => op.kind)).toEqual(['ins', 'set']);
    expect(doc.opsSince(doc.stateVector())).toEqual([]);
  });

  it('generates a random replica id when none is given and validates explicit ones', () => {
    expect(new Doc().replicaId).toMatch(/^[0-9a-z]{12}$/);
    expect(() => new Doc({ replicaId: '' })).toThrow(TypeError);
    expect(() => new Doc({ replicaId: 'x'.repeat(65) })).toThrow(TypeError);
  });
});

describe('Doc causal delivery', () => {
  const history = (): { source: Doc; ops: Op[] } => {
    const source = new Doc({ replicaId: 'b' });
    const ops = recordOps(source);
    const text = source.getText('t');
    text.insert(0, 'one');
    text.insert(3, ' two');
    text.delete(0, 4);
    text.insert(3, ' three');
    return { source, ops };
  };

  it('buffers out-of-order operations until the gap is filled', () => {
    const { source, ops } = history();
    const doc = new Doc({ replicaId: 'a' });
    doc.applyOps(ops.slice(2).reverse());
    expect(doc.getText('t').toString()).toBe('');
    expect(doc.pendingCount).toBe(2);
    doc.applyOps(ops.slice(0, 2));
    expect(doc.pendingCount).toBe(0);
    expect(doc.getText('t').toString()).toBe(source.getText('t').toString());
  });

  it('waits for dependencies from other replicas', () => {
    const a = new Doc({ replicaId: 'a' });
    const b = new Doc({ replicaId: 'b' });
    const c = new Doc({ replicaId: 'c' });
    const aOps = recordOps(a);
    a.getText('t').insert(0, 'base');
    pull(b, a);
    const bOps = recordOps(b);
    b.getText('t').insert(4, '+b');
    c.applyOps(bOps);
    expect(c.pendingCount).toBe(1);
    expect(c.missing().toJSON()).toEqual({ a: 4 });
    c.applyOps(aOps);
    expect(c.getText('t').toString()).toBe('base+b');
    expect(c.pendingCount).toBe(0);
  });

  it('ignores duplicates and does not re-emit them', () => {
    const { ops } = history();
    const doc = new Doc({ replicaId: 'a' });
    const events: UpdateEvent[] = [];
    doc.on('update', (e) => events.push(e));
    doc.applyOps(ops, 'peer');
    doc.applyOps(ops, 'peer');
    doc.applyOps([...ops].reverse(), 'peer');
    expect(events).toHaveLength(1);
    expect(events[0]?.ops).toHaveLength(ops.length);
    expect(events[0]?.origin).toBe('peer');
  });

  it('emits operations released from the buffer with the origin that completed them', () => {
    const { ops } = history();
    const doc = new Doc({ replicaId: 'a' });
    const origins: unknown[] = [];
    doc.on('update', (e) => origins.push(e.origin));
    doc.applyOps(ops.slice(1), 'late');
    expect(origins).toEqual([]);
    doc.applyOps(ops.slice(0, 1), 'first');
    expect(origins).toEqual(['first']);
  });
});

describe('Doc transactions and events', () => {
  it('batches local operations made inside transact into one update', () => {
    const doc = new Doc({ replicaId: 'a' });
    const events: UpdateEvent[] = [];
    doc.on('update', (e) => events.push(e));
    doc.transact(() => {
      doc.getText('t').insert(0, 'abc');
      doc.getMap('m').set('k', 'v');
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.ops.map((op) => op.kind)).toEqual(['ins', 'set']);
    expect(events[0]?.origin).toBe('local');
  });

  it('emits change events naming the touched types', () => {
    const a = new Doc({ replicaId: 'a' });
    const b = new Doc({ replicaId: 'b' });
    const changed: string[][] = [];
    b.on('change', (e) => changed.push([...e.targets].sort()));
    a.getText('notes').insert(0, 'x');
    a.getMap('board').set('s1', { x: 1 });
    pull(b, a);
    expect(changed).toEqual([['board', 'notes']]);
  });

  it('stops notifying after unsubscribe', () => {
    const doc = new Doc({ replicaId: 'a' });
    let count = 0;
    const off = doc.on('update', () => {
      count++;
    });
    doc.getText('t').insert(0, 'a');
    off();
    doc.getText('t').insert(0, 'b');
    expect(count).toBe(1);
  });
});

describe('Doc validation', () => {
  it('refuses to use one name for two different types', () => {
    const doc = new Doc({ replicaId: 'a' });
    doc.getText('shared');
    expect(() => doc.getMap('shared')).toThrow(TypeError);
  });

  it('rejects a remote update that targets a name with the wrong type, atomically', () => {
    const doc = new Doc({ replicaId: 'a' });
    doc.getText('t').insert(0, 'x');
    const bad: Op[] = [
      { kind: 'set', id: { replica: 'b', seq: 1 }, lamport: 1, target: 'm', key: 'k', value: 1 },
      { kind: 'set', id: { replica: 'b', seq: 2 }, lamport: 2, target: 't', key: 'k', value: 1 },
    ];
    expect(() => {
      doc.applyOps(bad);
    }).toThrow(InvalidOpError);
    expect(doc.stateVector().get('b')).toBe(0);
  });

  it.each<[string, Op]>([
    [
      'zero seq',
      { kind: 'set', id: { replica: 'b', seq: 0 }, lamport: 1, target: 'm', key: 'k', value: 1 },
    ],
    [
      'zero lamport',
      { kind: 'set', id: { replica: 'b', seq: 1 }, lamport: 0, target: 'm', key: 'k', value: 1 },
    ],
    [
      'empty replica',
      { kind: 'set', id: { replica: '', seq: 1 }, lamport: 1, target: 'm', key: 'k', value: 1 },
    ],
    [
      'empty target',
      { kind: 'set', id: { replica: 'b', seq: 1 }, lamport: 1, target: '', key: 'k', value: 1 },
    ],
    [
      'empty insert',
      {
        kind: 'ins',
        id: { replica: 'b', seq: 1 },
        lamport: 1,
        target: 't',
        origin: null,
        content: '',
      },
    ],
    [
      'lone surrogate',
      {
        kind: 'ins',
        id: { replica: 'b', seq: 1 },
        lamport: 1,
        target: 't',
        origin: null,
        content: '\uDC00',
      },
    ],
    [
      'empty delete',
      { kind: 'del', id: { replica: 'b', seq: 1 }, lamport: 1, target: 't', ranges: [] },
    ],
    [
      'bad range',
      {
        kind: 'del',
        id: { replica: 'b', seq: 1 },
        lamport: 1,
        target: 't',
        ranges: [{ replica: 'a', seq: 1, len: 0 }],
      },
    ],
    [
      'NaN value',
      {
        kind: 'set',
        id: { replica: 'b', seq: 1 },
        lamport: 1,
        target: 'm',
        key: 'k',
        value: Number.NaN,
      },
    ],
  ])('rejects malformed operation: %s', (_name, op) => {
    const doc = new Doc({ replicaId: 'a' });
    expect(() => {
      doc.applyOps([op]);
    }).toThrow(InvalidOpError);
  });

  it('rejects an operation that partially overlaps known history', () => {
    const a = new Doc({ replicaId: 'a' });
    a.getText('t').insert(0, 'abc');
    const doc = new Doc({ replicaId: 'z' });
    pull(doc, a);
    const overlap: Op = {
      kind: 'ins',
      id: { replica: 'a', seq: 3 },
      lamport: 9,
      target: 't',
      origin: null,
      content: 'xy',
    };
    expect(() => {
      doc.applyOps([overlap]);
    }).toThrow(InvalidOpError);
  });
});

describe('MapType', () => {
  it('sets, reads, deletes and lists keys', () => {
    const map = new Doc({ replicaId: 'a' }).getMap('m');
    map.set('b', 2);
    map.set('a', { nested: [1, 'two', null, true] });
    map.set('c', 'gone');
    map.delete('c');
    expect(map.get('b')).toBe(2);
    expect(map.has('c')).toBe(false);
    expect(map.keys()).toEqual(['a', 'b']);
    expect(map.size).toBe(2);
    expect(map.toJSON()).toEqual({ a: { nested: [1, 'two', null, true] }, b: 2 });
  });

  it('copies and freezes stored values', () => {
    const map = new Doc({ replicaId: 'a' }).getMap('m');
    const value = { points: [1, 2] };
    map.set('k', value);
    value.points.push(3);
    const stored = map.get('k') as { points: number[] };
    expect(stored.points).toEqual([1, 2]);
    expect(Object.isFrozen(stored.points)).toBe(true);
  });

  it('rejects values that are not JSON', () => {
    const map = new Doc({ replicaId: 'a' }).getMap('m');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const bad of [Number.POSITIVE_INFINITY, () => 1, [undefined], cyclic, new Date(0), 10n]) {
      expect(() => {
        map.set('k', bad as never);
      }).toThrow(TypeError);
    }
  });

  it('resolves concurrent writes to the same key with last-writer-wins', () => {
    const a = new Doc({ replicaId: 'a' });
    const b = new Doc({ replicaId: 'b' });
    a.getMap('m').set('color', 'red');
    b.getMap('m').set('color', 'blue');
    pull(a, b);
    pull(b, a);
    expect(a.getMap('m').get('color')).toBe('blue');
    expect(b.getMap('m').get('color')).toBe('blue');
    a.getMap('m').set('color', 'green');
    pull(b, a);
    expect(b.getMap('m').get('color')).toBe('green');
  });
});
