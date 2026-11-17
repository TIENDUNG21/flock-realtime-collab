import { afterEach, describe, expect, it } from 'vitest';
import { VirtualScheduler } from '@flock/sync';
import { LabModel, PEERS } from '../src/lab/lab-model.js';

let lab: LabModel | undefined;
afterEach(() => {
  lab?.destroy();
  lab = undefined;
});

const make = (): { lab: LabModel; s: VirtualScheduler } => {
  const s = new VirtualScheduler();
  lab = new LabModel({ scheduler: s, seed: 11, antiEntropyMs: 1000, logLimit: 50 });
  s.advance(1000);
  return { lab, s };
};

describe('LabModel', () => {
  it('starts with three connected, converged peers', () => {
    const { lab } = make();
    expect(lab.convergence()).toEqual({ state: 'converged' });
    expect(PEERS.every((p) => lab.isOnline(p))).toBe(true);
  });

  it('reports syncing while an edit is in flight, then converged', () => {
    const { lab, s } = make();
    lab.text('A').insert(0, 'hello');
    expect(lab.convergence().state).toBe('syncing');
    s.advance(600);
    expect(lab.convergence()).toEqual({ state: 'converged' });
    expect(lab.text('C').toString()).toBe('hello');
  });

  it('reports the cut links while a partitioned peer diverges, and heals', () => {
    const { lab, s } = make();
    lab.isolate('A');
    expect(lab.isOnline('A')).toBe(false);
    lab.text('A').insert(0, 'alone ');
    lab.text('B').insert(0, 'together ');
    s.advance(3000);
    const status = lab.convergence();
    expect(status.state).toBe('diverged');
    expect(status.state === 'diverged' && status.cut).toEqual([
      ['A', 'B'],
      ['A', 'C'],
    ]);
    expect(lab.text('C').toString()).toBe('together ');
    lab.heal();
    s.advance(2000);
    expect(lab.convergence()).toEqual({ state: 'converged' });
    expect(lab.text('C').toString()).toContain('alone');
  });

  it('logs deliveries, drops and link changes, and keeps the log bounded', () => {
    const { lab, s } = make();
    lab.setLink('A', 'B', { loss: 1 });
    lab.text('A').insert(0, 'x');
    s.advance(500);
    const kinds = new Set(lab.log().map((e) => e.kind));
    expect(kinds).toContain('link');
    expect(kinds).toContain('drop');
    expect(kinds).toContain('deliver');
    expect(lab.log().some((e) => e.kind === 'drop' && e.detail === 'lost')).toBe(true);
    for (let i = 0; i < 40; i++) {
      lab.text('B').insert(0, 'y');
      s.advance(50);
    }
    expect(lab.log().length).toBeLessThanOrEqual(50);
    expect(lab.stats.sent).toBeGreaterThan(lab.stats.delivered - 1);
    expect(lab.stats.dropped).toBeGreaterThan(0);
  });

  it('marks state-vector handshakes so the log can hide them', () => {
    const { lab, s } = make();
    s.advance(2500);
    const handshakes = lab.log().filter((e) => e.handshake);
    expect(handshakes.length).toBeGreaterThan(0);
    expect(handshakes.every((e) => e.summary.startsWith('sync-step'))).toBe(true);
  });

  it('keeps converging under chaos typing with lossy links', () => {
    const { lab, s } = make();
    lab.setLink('A', 'B', { loss: 0.3, duplicate: 0.2 });
    lab.setLink('B', 'C', { up: false });
    lab.startChaos(100);
    expect(lab.chaosRunning).toBe(true);
    s.advance(5000);
    lab.stopChaos();
    expect(lab.chaosRunning).toBe(false);
    const lengths = PEERS.map((p) => lab.text(p).length);
    expect(Math.max(...lengths)).toBeGreaterThan(0);
    lab.heal();
    s.advance(5000);
    expect(lab.convergence()).toEqual({ state: 'converged' });
  });
});
