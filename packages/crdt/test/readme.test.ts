import { describe, expect, it } from 'vitest';
import { Doc } from '@flock/crdt';

describe('README', () => {
  it('runs the two-replica example as printed', () => {
    const alice = new Doc({ replicaId: 'alice' });
    const bob = new Doc({ replicaId: 'bob' });
    alice.getText('note').insert(0, 'Hello');
    bob.applyUpdate(alice.encodeStateAsUpdate());

    alice.getText('note').insert(5, ', world'); // concurrent edits,
    bob.getText('note').insert(0, 'Draft: '); // no coordination

    alice.applyUpdate(bob.encodeStateAsUpdate(alice.stateVector()));
    bob.applyUpdate(alice.encodeStateAsUpdate(bob.stateVector()));

    expect(alice.getText('note').toString()).toBe('Draft: Hello, world');
    expect(bob.getText('note').toString()).toBe('Draft: Hello, world');
  });

  it('documents a known RGA limitation: concurrent backward typing interleaves', () => {
    // Each keystroke is inserted before the previous one, so every character has the same
    // origin and siblings are ordered by Lamport time alone (Kleppmann et al., PaPoC 2019).
    const a = new Doc({ replicaId: 'a' });
    const b = new Doc({ replicaId: 'b' });
    for (const ch of ['3', '2', '1']) a.getText('t').insert(0, `a${ch}`);
    for (const ch of ['3', '2', '1']) b.getText('t').insert(0, `b${ch}`);
    a.applyUpdate(b.encodeStateAsUpdate());
    b.applyUpdate(a.encodeStateAsUpdate());
    expect(a.getText('t').toString()).toBe(b.getText('t').toString());
    expect(a.getText('t').toString()).toBe('b1a1b2a2b3a3');
  });
});
