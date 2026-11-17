import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Rng, SimNetwork, VirtualScheduler, type NetworkEvent } from '@flock/sync';

const trio = (seed = 1, antiEntropyMs = 1000): { net: SimNetwork; s: VirtualScheduler } => {
  const s = new VirtualScheduler();
  const net = new SimNetwork({ scheduler: s, seed, antiEntropyMs });
  for (const id of ['A', 'B', 'C']) net.addPeer(id);
  net.link('A', 'B');
  net.link('B', 'C');
  net.link('A', 'C');
  return { net, s };
};

const text = (net: SimNetwork, id: string): string => net.peer(id).doc.getText('t').toString();

describe('Rng', () => {
  it('is reproducible from its seed and stays in range', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b.next()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
    expect(() => new Rng(1).pick([])).toThrow(RangeError);
  });
});

describe('SimNetwork', () => {
  it('delivers messages after the configured latency', () => {
    const s = new VirtualScheduler();
    const net = new SimNetwork({ scheduler: s });
    net.addPeer('A');
    net.addPeer('B');
    net.link('A', 'B', { latencyMs: 100, jitterMs: 0 });
    s.advance(250);
    net.peer('A').doc.getText('t').insert(0, 'x');
    s.advance(99);
    expect(text(net, 'B')).toBe('');
    s.advance(1);
    expect(text(net, 'B')).toBe('x');
  });

  it('produces identical event logs for identical seeds', () => {
    const run = (): string[] => {
      const { net, s } = trio(7);
      net.setLink('A', 'B', { loss: 0.3, duplicate: 0.3, jitterMs: 80 });
      const log: string[] = [];
      net.on('event', (e) => log.push(`${e.time}:${e.type}`));
      net.peer('A').doc.getText('t').insert(0, 'hello');
      net.peer('B').doc.getText('t').insert(0, 'world');
      s.advance(5000);
      return log;
    };
    const first = run();
    expect(first.length).toBeGreaterThan(10);
    expect(run()).toEqual(first);
  });

  it('keeps partitioned peers apart and converges them after healing', () => {
    const { net, s } = trio();
    s.advance(500);
    net.setLink('A', 'B', { up: false });
    net.setLink('A', 'C', { up: false });
    net.peer('A').doc.getText('t').insert(0, 'island ');
    net.peer('B').doc.getText('t').insert(0, 'mainland ');
    s.advance(5000);
    expect(text(net, 'A')).toBe('island ');
    expect(text(net, 'C')).toBe('mainland ');
    expect(net.isConverged()).toBe(false);
    net.setLink('A', 'B', { up: true });
    s.advance(500);
    expect(net.isConverged()).toBe(true);
    expect(text(net, 'C')).toContain('island');
  });

  it('routes around a broken link through a third peer', () => {
    const { net, s } = trio();
    net.setLink('A', 'B', { up: false });
    net.peer('A').doc.getText('t').insert(0, 'detour');
    s.advance(500);
    expect(text(net, 'B')).toBe('detour');
  });

  it('drops in-flight messages when a partition starts', () => {
    const { net, s } = trio();
    s.advance(500);
    const drops: NetworkEvent[] = [];
    net.on('event', (e) => {
      if (e.type === 'drop') drops.push(e);
    });
    net.peer('A').doc.getText('t').insert(0, 'x');
    net.setLink('A', 'B', { up: false });
    s.advance(200);
    expect(drops.some((e) => e.type === 'drop' && e.reason === 'partition')).toBe(true);
  });

  it('converges despite heavy loss and duplication thanks to anti-entropy', () => {
    const { net, s } = trio(3);
    for (const [a, b] of [
      ['A', 'B'],
      ['B', 'C'],
      ['A', 'C'],
    ] as const) {
      net.setLink(a, b, { loss: 0.5, duplicate: 0.3, jitterMs: 200 });
    }
    for (let i = 0; i < 20; i++) {
      const id = ['A', 'B', 'C'][i % 3] ?? 'A';
      const t = net.peer(id).doc.getText('t');
      t.insert(i % 2 === 0 ? 0 : t.length, `${id}${i} `);
      s.advance(37);
    }
    s.advance(30_000);
    expect(net.isConverged()).toBe(true);
  });

  it('repairs a lost final update on a live link only through anti-entropy', () => {
    const s = new VirtualScheduler();
    const net = new SimNetwork({ scheduler: s, antiEntropyMs: 1000 });
    net.addPeer('A');
    net.addPeer('B');
    net.link('A', 'B', { jitterMs: 0 });
    s.advance(100);
    net.setLink('A', 'B', { loss: 1 });
    net.peer('A').doc.getText('t').insert(0, 'last word');
    s.advance(100);
    net.setLink('A', 'B', { loss: 0 });
    s.advance(100);
    expect(text(net, 'B')).toBe('');
    s.advance(1000);
    expect(text(net, 'B')).toBe('last word');
  });

  it('describes traffic for the op log', () => {
    const { net, s } = trio();
    const summaries: string[] = [];
    net.on('event', (e) => {
      if (e.type === 'deliver') summaries.push(e.summary);
    });
    s.advance(500);
    net.peer('A').doc.getText('t').insert(0, 'hi');
    s.advance(1500); // includes one anti-entropy round
    expect(summaries).toContain('update (1 op)');
    expect(summaries.some((x) => x.startsWith('sync-step1'))).toBe(true);
  });

  it('converges after any sequence of edits, partitions, loss and latency changes', () => {
    const pair = fc.constantFrom(['A', 'B'], ['B', 'C'], ['A', 'C']);
    const action = fc.oneof(
      fc.record({
        t: fc.constant('edit' as const),
        peer: fc.constantFrom('A', 'B', 'C'),
        at: fc.double({ min: 0, max: 1, noNaN: true }),
        del: fc.boolean(),
      }),
      fc.record({
        t: fc.constant('link' as const),
        pair,
        up: fc.boolean(),
        loss: fc.constantFrom(0, 0.2, 0.6),
        latency: fc.integer({ min: 0, max: 400 }),
      }),
      fc.record({ t: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 800 }) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), fc.integer(), (actions, seed) => {
        const { net, s } = trio(seed);
        let n = 0;
        for (const a of actions) {
          if (a.t === 'edit') {
            const t = net.peer(a.peer).doc.getText('t');
            const at = Math.floor(a.at * t.length);
            if (a.del && t.length > 0) t.delete(Math.min(at, t.length - 1), 1);
            else t.insert(at, `${a.peer}${n++}`);
          } else if (a.t === 'link') {
            const [x, y] = a.pair as [string, string];
            net.setLink(x, y, { up: a.up, loss: a.loss, latencyMs: a.latency });
          } else {
            s.advance(a.ms);
          }
        }
        for (const [x, y] of [
          ['A', 'B'],
          ['B', 'C'],
          ['A', 'C'],
        ] as const) {
          net.setLink(x, y, { up: true, loss: 0 });
        }
        s.advance(10_000);
        expect(net.isConverged()).toBe(true);
        net.destroy();
      }),
      { numRuns: 60 },
    );
  });
});
