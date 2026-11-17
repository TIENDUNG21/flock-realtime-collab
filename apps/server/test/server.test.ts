import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Doc } from '@flock/crdt';
import { SyncSession, encodeMessage } from '@flock/sync';
import {
  CloseCode,
  loadConfig,
  silentLogger,
  startFlockServer,
  type FlockServer,
} from '../src/index.js';

const PORT = 5132;
let dir: string;
let server: FlockServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flock-server-'));
  server = await startFlockServer({
    port: PORT,
    dataDir: dir,
    logger: silentLogger,
    idleCloseMs: 50,
  });
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const open = (path: string, headers: Record<string, string> = {}): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.url}${path}`, { headers });
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.once('error', reject);
  });

const closed = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });

describe('HTTP endpoints', () => {
  it('reports health and room statistics', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', rooms: 0, clients: 0 });
    const missing = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(missing.status).toBe(404);
  });
});

describe('WebSocket rooms', () => {
  it.each(['/rooms/', '/rooms/..%2Fsecret', '/rooms/a%20b', '/elsewhere', '/rooms/%E0%A4%A'])(
    'refuses the upgrade for %s with HTTP 400',
    async (path) => {
      await expect(open(path)).rejects.toThrow('HTTP 400');
    },
  );

  it('closes a client that sends a malformed binary message with 1007, and only that client', async () => {
    const good = await open('/rooms/shared');
    const bad = await open('/rooms/shared');
    const badClosed = closed(bad);
    bad.send(Uint8Array.of(2, 9, 9, 9));
    expect((await badClosed).code).toBe(CloseCode.InvalidPayload);
    expect(good.readyState).toBe(WebSocket.OPEN);
    good.close();
  });

  it('closes a client that sends text frames with 1003', async () => {
    const ws = await open('/rooms/text');
    const done = closed(ws);
    ws.send('hello');
    expect((await done).code).toBe(CloseCode.UnsupportedData);
  });

  it('syncs a raw protocol client and counts it in the stats', async () => {
    const ws = await open('/rooms/raw');
    const doc = new Doc({ replicaId: 'raw-client' });
    const session = new SyncSession(doc, {
      antiEntropyMs: 0,
      send: (bytes) => {
        ws.send(bytes);
      },
    });
    ws.on('message', (data: Buffer) => {
      session.receive(new Uint8Array(data));
    });
    const synced = new Promise<void>((resolve) =>
      session.on('synced', () => {
        resolve();
      }),
    );
    session.connect();
    await synced;
    doc.getText('t').insert(0, 'stored on the server');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.stats()).toEqual({ rooms: 1, clients: 1 });
    ws.send(
      encodeMessage({
        type: 'awareness',
        entries: [{ replica: 'raw-client', clock: 1, state: { name: 'raw' } }],
      }),
    );
    const done = closed(ws);
    ws.close();
    await done;
    await new Promise((r) => setTimeout(r, 150));
    expect(server.stats()).toEqual({ rooms: 0, clients: 0 });
  });
});

describe('origin allow-list', () => {
  it('refuses upgrades from origins that are not listed', async () => {
    const strictDir = mkdtempSync(join(tmpdir(), 'flock-strict-'));
    const strict = await startFlockServer({
      port: PORT + 1,
      dataDir: strictDir,
      logger: silentLogger,
      allowedOrigins: ['http://localhost:5135'],
    });
    try {
      const attempt = (origin: string): Promise<number> =>
        new Promise((resolve) => {
          const ws = new WebSocket(`${strict.url}/rooms/x`, { headers: { origin } });
          ws.once('open', () => {
            ws.close();
            resolve(101);
          });
          ws.once('unexpected-response', (_req, res) => {
            resolve(res.statusCode ?? 0);
          });
          ws.once('error', () => {
            resolve(-1);
          });
        });
      expect(await attempt('http://evil.example')).toBe(403);
      expect(await attempt('http://localhost:5135')).toBe(101);
    } finally {
      await strict.close();
      rmSync(strictDir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig', () => {
  it('uses defaults', () => {
    const config = loadConfig({}, '/srv');
    expect(config.port).toBe(5130);
    expect(config.host).toBe('127.0.0.1');
    expect(config.fsync).toBe(false);
    expect(config.allowedOrigins).toBeUndefined();
    expect(config.dataDir.replaceAll('\\', '/')).toMatch(/\/srv\/data$/);
  });

  it('reads overrides and validates them', () => {
    const config = loadConfig(
      {
        PORT: '6000',
        FLOCK_FSYNC: 'true',
        FLOCK_ALLOWED_ORIGINS: 'http://a, http://b',
        FLOCK_COMPACT_EVERY: '50',
      },
      '/srv',
    );
    expect(config).toMatchObject({
      port: 6000,
      fsync: true,
      compactEvery: 50,
      allowedOrigins: ['http://a', 'http://b'],
    });
    expect(() => loadConfig({ PORT: 'eighty' }, '/')).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' }, '/')).toThrow(/PORT/);
    expect(() => loadConfig({ FLOCK_FSYNC: 'yes' }, '/')).toThrow(/FLOCK_FSYNC/);
  });
});
