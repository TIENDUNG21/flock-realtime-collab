import { describe, expect, it } from 'vitest';
import { Doc } from '@flock/crdt';
import {
  VirtualScheduler,
  WebSocketProvider,
  decodeMessage,
  type ProviderStatus,
  type WebSocketLike,
} from '@flock/sync';

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  closedWith: number | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
  types(): string[] {
    return this.sent.map((b) => decodeMessage(b).type);
  }
}

const setup = (): {
  doc: Doc;
  scheduler: VirtualScheduler;
  sockets: FakeSocket[];
  provider: WebSocketProvider;
  statuses: ProviderStatus[];
} => {
  const doc = new Doc({ replicaId: 'client' });
  const scheduler = new VirtualScheduler();
  const sockets: FakeSocket[] = [];
  const provider = new WebSocketProvider('ws://example.test/', 'my room', doc, {
    scheduler,
    random: () => 0.5,
    minBackoffMs: 100,
    maxBackoffMs: 1000,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  const statuses: ProviderStatus[] = [];
  provider.on('status', (s) => statuses.push(s));
  return { doc, scheduler, sockets, provider, statuses };
};

describe('WebSocketProvider', () => {
  it('builds the room URL and opens a binary socket', () => {
    const { sockets, provider } = setup();
    expect(provider.url).toBe('ws://example.test/rooms/my%20room');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.binaryType).toBe('arraybuffer');
    expect(provider.status).toBe('connecting');
  });

  it('starts the sync handshake when the socket opens', () => {
    const { sockets, statuses } = setup();
    sockets[0]?.open();
    expect(statuses).toEqual(['connected']);
    expect(sockets[0]?.types()).toEqual(['sync-step1']);
  });

  it('queues offline edits and sends them after connecting', () => {
    const { doc, sockets } = setup();
    doc.getText('t').insert(0, 'typed offline');
    expect(sockets[0]?.sent).toHaveLength(0);
    sockets[0]?.open();
    expect(sockets[0]?.types()).toEqual(['sync-step1', 'update']);
  });

  it('reconnects with exponential backoff after unexpected closes', () => {
    const { scheduler, sockets, provider, statuses } = setup();
    expect([0, 1, 2, 3, 4].map((n) => provider.backoffFor(n))).toEqual([100, 200, 400, 800, 1000]);
    sockets[0]?.drop();
    expect(statuses.at(-1)).toBe('disconnected');
    scheduler.advance(74); // 100 * (0.5 + 0.5 * 0.5) = 75
    expect(sockets).toHaveLength(1);
    scheduler.advance(1);
    expect(sockets).toHaveLength(2);
    sockets[1]?.drop();
    scheduler.advance(149);
    expect(sockets).toHaveLength(2);
    scheduler.advance(1);
    expect(sockets).toHaveLength(3);
    sockets[2]?.open();
    sockets[2]?.drop();
    scheduler.advance(75); // attempts reset after a successful open
    expect(sockets).toHaveLength(4);
  });

  it('applies messages from the server', () => {
    const { doc, sockets } = setup();
    sockets[0]?.open();
    const remote = new Doc({ replicaId: 'remote' });
    remote.getText('t').insert(0, 'from server');
    const msg = Uint8Array.of(2, ...remote.encodeStateAsUpdate());
    sockets[0]?.onmessage?.({ data: msg.buffer });
    expect(doc.getText('t').toString()).toBe('from server');
  });

  it('closes the socket with 1007 when the server sends garbage', () => {
    const { sockets, provider } = setup();
    const errors: Error[] = [];
    provider.on('error', (e) => errors.push(e));
    sockets[0]?.open();
    sockets[0]?.onmessage?.({ data: Uint8Array.of(9, 9).buffer });
    expect(errors).toHaveLength(1);
    expect(sockets[0]?.closedWith).toBe(1007);
  });

  it('stays offline after disconnect and does not reconnect after destroy', () => {
    const { scheduler, sockets, provider } = setup();
    sockets[0]?.open();
    provider.disconnect();
    expect(sockets[0]?.closedWith).toBe(1000);
    scheduler.advance(10_000);
    expect(sockets).toHaveLength(1);
    provider.connect();
    expect(sockets).toHaveLength(2);
    provider.destroy();
    scheduler.advance(10_000);
    expect(sockets).toHaveLength(2);
    expect(provider.status).toBe('disconnected');
  });
});
