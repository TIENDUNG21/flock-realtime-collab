import { describe, expect, it } from 'vitest';
import { DecodeError, Doc } from '@flock/crdt';
import { Awareness, SyncSession, VirtualScheduler, decodeMessage } from '@flock/sync';

interface Peer {
  doc: Doc;
  awareness: Awareness;
}

const peer = (id: string, scheduler: VirtualScheduler): Peer => ({
  doc: new Doc({ replicaId: id }),
  awareness: new Awareness(id, { scheduler }),
});

/** Two sessions joined by an in-memory, manually flushed queue. */
class Link {
  readonly queue: Array<{ to: SyncSession; bytes: Uint8Array }> = [];
  readonly left: SyncSession;
  readonly right: SyncSession;
  /** Drop rule applied at delivery time. */
  drop: (bytes: Uint8Array) => boolean = () => false;
  delivered: string[] = [];

  constructor(a: Peer, b: Peer, scheduler: VirtualScheduler, antiEntropyMs = 1000) {
    this.left = new SyncSession(a.doc, {
      awareness: a.awareness,
      scheduler,
      antiEntropyMs,
      send: (bytes) => this.queue.push({ to: this.right, bytes }),
    });
    this.right = new SyncSession(b.doc, {
      awareness: b.awareness,
      scheduler,
      antiEntropyMs,
      send: (bytes) => this.queue.push({ to: this.left, bytes }),
    });
  }

  connect(): void {
    this.left.connect();
    this.right.connect();
  }

  disconnect(): void {
    this.left.disconnect();
    this.right.disconnect();
    this.queue.length = 0;
  }

  flush(): void {
    for (let guard = 0; this.queue.length > 0 && guard < 10_000; guard++) {
      const next = this.queue.shift();
      if (!next || this.drop(next.bytes)) continue;
      this.delivered.push(decodeMessage(next.bytes).type);
      next.to.receive(next.bytes);
    }
  }
}

const text = (p: Peer): string => p.doc.getText('t').toString();

describe('SyncSession', () => {
  it('brings two diverged documents to the same state on connect', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    a.doc.getText('t').insert(0, 'from a. ');
    b.doc.getText('t').insert(0, 'from b. ');
    b.doc.getMap('m').set('k', 1);
    const link = new Link(a, b, s);
    link.connect();
    link.flush();
    expect(a.doc.debugState()).toEqual(b.doc.debugState());
    expect(link.left.synced && link.right.synced).toBe(true);
  });

  it('streams live edits while connected', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s);
    link.connect();
    link.flush();
    a.doc.getText('t').insert(0, 'hello');
    link.flush();
    b.doc.getText('t').insert(5, ' world');
    link.flush();
    expect(text(a)).toBe('hello world');
    expect(link.delivered.filter((t) => t === 'update')).toHaveLength(2);
  });

  it('queues edits while disconnected and replays them on reconnect', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s);
    link.connect();
    link.flush();
    link.disconnect();
    a.doc.getText('t').insert(0, 'offline ');
    a.doc.getText('t').insert(8, 'edits');
    b.doc.getText('t').insert(0, '!');
    expect(link.left.outboxSize).toBe(2);
    expect(link.queue).toHaveLength(0);
    link.connect();
    expect(link.left.outboxSize).toBe(0);
    link.flush();
    expect(text(a)).toBe(text(b));
    expect(text(a)).toContain('offline edits');
  });

  it('recovers lost updates through periodic anti-entropy', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s, 1000);
    link.connect();
    link.flush();
    link.drop = (bytes) => decodeMessage(bytes).type === 'update';
    a.doc.getText('t').insert(0, 'lost?');
    link.flush();
    expect(text(b)).toBe('');
    link.drop = () => false;
    s.advance(1000);
    link.flush();
    expect(text(b)).toBe('lost?');
  });

  it('asks for missing history right away when an update has a gap', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s, 60_000);
    link.connect();
    link.flush();
    let dropped = false;
    link.drop = (bytes) => {
      if (!dropped && decodeMessage(bytes).type === 'update') return (dropped = true);
      return false;
    };
    a.doc.getText('t').insert(0, 'one');
    a.doc.getText('t').insert(3, ' two');
    link.flush();
    expect(b.doc.pendingCount).toBe(1);
    s.advance(100);
    link.flush();
    expect(text(b)).toBe('one two');
    expect(b.doc.pendingCount).toBe(0);
  });

  it('relays edits between peers that are not directly connected', () => {
    const s = new VirtualScheduler();
    const [a, b, c] = [peer('a', s), peer('b', s), peer('c', s)];
    const ab = new Link(a, b, s);
    const bc = new Link(b, c, s);
    ab.connect();
    bc.connect();
    a.doc.getText('t').insert(0, 'via b');
    for (let i = 0; i < 3; i++) {
      ab.flush();
      bc.flush();
    }
    expect(text(c)).toBe('via b');
  });

  it('exchanges awareness on connect and relays later changes', () => {
    const s = new VirtualScheduler();
    const [a, b, c] = [peer('a', s), peer('b', s), peer('c', s)];
    a.awareness.setLocalState({ name: 'Ana' });
    const ab = new Link(a, b, s);
    const bc = new Link(b, c, s);
    ab.connect();
    bc.connect();
    ab.flush();
    bc.flush();
    expect(c.awareness.getStates().get('a')).toEqual({ name: 'Ana' });
    expect([...ab.right.remoteReplicas]).toEqual(['a']);
    a.awareness.setLocalState({ name: 'Ana', cursor: 3 });
    ab.flush();
    bc.flush();
    expect(c.awareness.getStates().get('a')).toEqual({ name: 'Ana', cursor: 3 });
  });

  it('emits synced once the first step 2 arrives', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s);
    let synced = 0;
    link.left.on('synced', () => {
      synced++;
    });
    link.connect();
    expect(link.left.synced).toBe(false);
    link.flush();
    s.advance(5000);
    link.flush();
    expect(synced).toBe(1);
  });

  it('rejects malformed input with DecodeError and keeps working', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s);
    link.connect();
    link.flush();
    expect(() => {
      link.right.receive(Uint8Array.of(2, 1, 9, 9));
    }).toThrow(DecodeError);
    a.doc.getText('t').insert(0, 'still fine');
    link.flush();
    expect(text(b)).toBe('still fine');
  });

  it('stops sending and listening after destroy', () => {
    const s = new VirtualScheduler();
    const a = peer('a', s);
    const b = peer('b', s);
    const link = new Link(a, b, s);
    link.connect();
    link.flush();
    link.left.destroy();
    a.doc.getText('t').insert(0, 'unsent');
    s.advance(10_000);
    expect(link.queue.filter((m) => m.to === link.right)).toHaveLength(0);
  });
});
