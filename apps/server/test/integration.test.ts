import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Doc } from '@flock/crdt';
import { Awareness, WebSocketProvider } from '@flock/sync';
import { silentLogger, startFlockServer, type FlockServer } from '../src/index.js';

const PORT = 5131;
const ROOM = 'integration';
const dir = mkdtempSync(join(tmpdir(), 'flock-it-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(10);
  }
}

const start = (): Promise<FlockServer> =>
  startFlockServer({
    port: PORT,
    dataDir: dir,
    logger: silentLogger,
    compactEvery: 25,
    idleCloseMs: 50,
  });

interface Client {
  name: string;
  doc: Doc;
  awareness: Awareness;
  provider: WebSocketProvider;
}

function client(name: string): Client {
  const doc = new Doc({ replicaId: name });
  const awareness = new Awareness(name);
  const provider = new WebSocketProvider(`ws://127.0.0.1:${PORT}`, ROOM, doc, {
    awareness,
    antiEntropyMs: 300,
    minBackoffMs: 50,
    maxBackoffMs: 200,
  });
  return { name, doc, awareness, provider };
}

const text = (c: Client): string => c.doc.getText('notes').toString();
const state = (c: Client): string => JSON.stringify(c.doc.debugState());
const converged = (cs: Client[]): boolean => cs.every((c) => state(c) === state(cs[0] as Client));

describe('server integration (real WebSocket clients)', () => {
  it('converges concurrent edits, replays an offline client, survives restarts', async () => {
    let server = await start();
    const clients = ['alice', 'bob', 'carol'].map(client);
    const [alice, bob, carol] = clients as [Client, Client, Client];
    await waitFor('initial sync', () => clients.every((c) => c.provider.synced));

    // 1. Concurrent edits from all three clients, without waiting in between.
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    for (let i = 0; i < 30; i++) {
      for (const c of clients) {
        const t = c.doc.getText('notes');
        t.insert(rand(t.length + 1), `${c.name[0] ?? '?'}${i} `);
        if (i % 7 === 0 && t.length > 4) t.delete(rand(t.length - 2), 2);
        c.doc.getMap('board').set(`shape-${c.name}-${i % 5}`, { x: i, y: rand(100), by: c.name });
      }
    }
    await waitFor('convergence after concurrent edits', () => converged(clients));
    expect(text(alice).length).toBeGreaterThan(100);

    // 2. One client goes offline, keeps editing, and comes back.
    carol.provider.disconnect();
    expect(carol.provider.status).toBe('disconnected');
    alice.doc.getText('notes').insert(0, '[alice while carol is away] ');
    carol.doc.getText('notes').insert(0, '[carol offline edit] ');
    await sleep(150);
    expect(text(carol)).not.toContain('alice while carol is away');
    expect(text(alice)).not.toContain('carol offline edit');
    carol.provider.connect();
    await waitFor('convergence after reconnect', () => converged(clients));
    expect(text(bob)).toContain('[carol offline edit]');
    expect(text(carol)).toContain('[alice while carol is away]');

    // 3. Presence is relayed and removed when a client leaves.
    alice.awareness.setLocalState({ name: 'Alice', color: '#2dd4bf' });
    bob.awareness.setLocalState({ name: 'Bob', color: '#f5b942' });
    await waitFor(
      'presence relay',
      () => carol.awareness.getStates().has('alice') && alice.awareness.getStates().has('bob'),
    );
    bob.provider.destroy();
    bob.awareness.destroy();
    await waitFor('presence removal', () => !alice.awareness.getStates().has('bob'));

    // 4. The server restarts while alice and carol stay up; an edit made during the outage syncs.
    await server.close();
    await waitFor('clients notice the outage', () => alice.provider.status !== 'connected');
    alice.doc.getText('notes').insert(0, '[written while the server was down] ');
    server = await start();
    const alive = [alice, carol];
    await waitFor('reconnect after restart', () =>
      alive.every((c) => c.provider.status === 'connected'),
    );
    await waitFor('convergence after restart', () => converged(alive));
    expect(text(carol)).toContain('[written while the server was down]');

    // 5. A cold restart with no clients: a new client gets everything from disk alone.
    const final = state(alice);
    for (const c of alive) {
      c.provider.destroy();
      c.awareness.destroy();
    }
    await server.close();
    expect(existsSync(join(dir, `${ROOM}.flog`))).toBe(true);
    server = await start();
    const dave = client('dave');
    await waitFor('late joiner sync', () => dave.provider.synced);
    expect(state(dave)).toBe(final);
    dave.provider.destroy();
    dave.awareness.destroy();
    await server.close();
  }, 30_000);
});
