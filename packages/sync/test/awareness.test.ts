import { describe, expect, it } from 'vitest';
import {
  Awareness,
  VirtualScheduler,
  type AwarenessChange,
  type AwarenessEntry,
} from '@flock/sync';

describe('VirtualScheduler', () => {
  it('runs timers in time order, ties in creation order, and skips cleared ones', () => {
    const s = new VirtualScheduler();
    const log: string[] = [];
    s.setTimeout(() => log.push('b@20'), 20);
    s.setTimeout(() => log.push('a@10'), 10);
    const cancelled = s.setTimeout(() => log.push('never'), 15);
    s.setTimeout(() => log.push('c@20'), 20);
    s.clearTimeout(cancelled);
    s.advance(19);
    expect(log).toEqual(['a@10']);
    expect(s.now()).toBe(19);
    s.advance(1);
    expect(log).toEqual(['a@10', 'b@20', 'c@20']);
  });

  it('runs timers scheduled by other timers within the same advance', () => {
    const s = new VirtualScheduler();
    const log: number[] = [];
    s.setTimeout(() => {
      log.push(s.now());
      s.setTimeout(() => log.push(s.now()), 5);
    }, 5);
    s.advance(10);
    expect(log).toEqual([5, 10]);
    expect(s.pending).toBe(0);
  });
});

const entriesOf = (a: Awareness): AwarenessEntry[] => {
  const out: AwarenessEntry[] = [];
  a.on('update', (u) => out.push(...u.entries));
  return out;
};

describe('Awareness', () => {
  it('publishes local state changes with an increasing clock', () => {
    const a = new Awareness('a', { scheduler: new VirtualScheduler() });
    const sent = entriesOf(a);
    a.setLocalState({ name: 'Ana' });
    a.setLocalField('cursor', 4);
    expect(sent).toEqual([
      { replica: 'a', clock: 1, state: { name: 'Ana' } },
      { replica: 'a', clock: 2, state: { name: 'Ana', cursor: 4 } },
    ]);
    expect(a.getStates().get('a')).toEqual({ name: 'Ana', cursor: 4 });
  });

  it('keeps the entry with the highest clock and reports what changed', () => {
    const a = new Awareness('a', { scheduler: new VirtualScheduler() });
    const changes: AwarenessChange[] = [];
    a.on('change', (c) => changes.push(c));
    a.applyEntries([{ replica: 'b', clock: 2, state: { x: 1 } }], 'net');
    a.applyEntries([{ replica: 'b', clock: 1, state: { x: 0 } }], 'net');
    a.applyEntries([{ replica: 'b', clock: 3, state: { x: 2 } }], 'net');
    a.applyEntries([{ replica: 'b', clock: 4, state: null }], 'net');
    expect(changes.map((c) => [c.added, c.updated, c.removed])).toEqual([
      [['b'], [], []],
      [[], ['b'], []],
      [[], [], ['b']],
    ]);
    expect(a.getStates().has('b')).toBe(false);
  });

  it('times out silent peers and renews its own state', () => {
    const scheduler = new VirtualScheduler();
    const a = new Awareness('a', { scheduler, timeoutMs: 30_000 });
    const sent = entriesOf(a);
    a.setLocalState({ name: 'Ana' });
    a.applyEntries([{ replica: 'b', clock: 1, state: { name: 'Bo' } }], 'net');
    scheduler.advance(20_000);
    expect(a.getStates().has('b')).toBe(true);
    expect(sent.at(-1)?.clock).toBeGreaterThan(1); // renewed at least once
    scheduler.advance(15_000);
    expect(a.getStates().has('b')).toBe(false);
    expect(a.getStates().has('a')).toBe(true);
    a.destroy();
  });

  it('removes peers with a clock bump so the removal wins everywhere', () => {
    const server = new Awareness('server', { scheduler: new VirtualScheduler() });
    const sent = entriesOf(server);
    server.applyEntries([{ replica: 'b', clock: 5, state: { name: 'Bo' } }], 'net');
    server.removeStates(['b'], 'disconnect');
    expect(sent).toEqual([
      { replica: 'b', clock: 5, state: { name: 'Bo' } },
      { replica: 'b', clock: 6, state: null },
    ]);
  });

  it('re-asserts its own state when told it has left', () => {
    const a = new Awareness('a', { scheduler: new VirtualScheduler() });
    const sent = entriesOf(a);
    a.setLocalState({ name: 'Ana' });
    a.applyEntries([{ replica: 'a', clock: 7, state: null }], 'net');
    expect(sent.at(-1)).toEqual({ replica: 'a', clock: 8, state: { name: 'Ana' } });
  });

  it('lists the full known state for a newly connected peer', () => {
    const a = new Awareness('a', { scheduler: new VirtualScheduler() });
    a.setLocalState({ name: 'Ana' });
    a.applyEntries(
      [
        { replica: 'b', clock: 3, state: { name: 'Bo' } },
        { replica: 'c', clock: 2, state: null },
      ],
      'net',
    );
    expect(a.entries().map((e) => e.replica)).toEqual(['a', 'b']);
  });

  it('announces its departure on destroy', () => {
    const a = new Awareness('a', { scheduler: new VirtualScheduler() });
    const sent = entriesOf(a);
    a.setLocalState({ name: 'Ana' });
    a.destroy();
    expect(sent.at(-1)).toEqual({ replica: 'a', clock: 2, state: null });
  });
});
