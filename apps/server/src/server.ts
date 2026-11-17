import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { errorMessage, jsonLogger, type Logger } from './logger.js';
import { Room } from './room.js';
import { isValidRoomName } from './validate.js';

export interface FlockServerOptions {
  /** TCP port; 0 picks a free one. */
  readonly port?: number;
  readonly host?: string;
  readonly dataDir: string;
  readonly compactEvery?: number;
  readonly fsync?: boolean;
  /** Largest accepted WebSocket message. */
  readonly maxPayloadBytes?: number;
  /** When set, WebSocket upgrades from other origins are refused with 403. */
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly heartbeatMs?: number;
  /** How long an empty room stays loaded before it is closed. */
  readonly idleCloseMs?: number;
  readonly logger?: Logger;
}

export interface ServerStats {
  readonly rooms: number;
  readonly clients: number;
}

export interface FlockServer {
  readonly port: number;
  /** Base WebSocket URL, e.g. `ws://127.0.0.1:5130`. */
  readonly url: string;
  stats(): ServerStats;
  close(): Promise<void>;
}

/** WebSocket close codes used by the server. */
export const CloseCode = {
  GoingAway: 1001,
  UnsupportedData: 1003,
  InvalidPayload: 1007,
  InternalError: 1011,
} as const;

const ROOM_PATH = /^\/rooms\/([^/]+)$/;

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function roomFromUrl(url: string | undefined): string | null {
  const match = ROOM_PATH.exec(new URL(url ?? '/', 'http://localhost').pathname);
  if (!match?.[1]) return null;
  try {
    const name = decodeURIComponent(match[1]);
    return isValidRoomName(name) ? name : null;
  } catch {
    return null;
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

/**
 * Starts the relay: an HTTP server with `GET /health` and WebSocket rooms at `/rooms/<name>`.
 * Each message is a binary sync-protocol frame; anything else closes that one connection.
 */
export async function startFlockServer(options: FlockServerOptions): Promise<FlockServer> {
  const logger = options.logger ?? jsonLogger;
  const roomOptions = {
    dataDir: options.dataDir,
    compactEvery: options.compactEvery ?? 1000,
    fsync: options.fsync ?? false,
    logger,
  };
  const idleCloseMs = options.idleCloseMs ?? 30_000;
  const rooms = new Map<string, Room>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const alive = new WeakMap<WebSocket, boolean>();

  const getRoom = (name: string): Room => {
    const timer = idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(name);
    }
    let room = rooms.get(name);
    if (!room) {
      room = Room.open(name, roomOptions);
      rooms.set(name, room);
    }
    return room;
  };

  const releaseRoom = (room: Room): void => {
    if (room.clientCount > 0 || idleTimers.has(room.name)) return;
    idleTimers.set(
      room.name,
      setTimeout(() => {
        idleTimers.delete(room.name);
        if (room.clientCount === 0 && rooms.get(room.name) === room) {
          rooms.delete(room.name);
          room.close();
        }
      }, idleCloseMs),
    );
  };

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      const body = JSON.stringify({ status: 'ok', ...stats() });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', rooms: '/rooms/<name> (WebSocket)' }));
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 1024 * 1024,
  });

  const attach = (ws: WebSocket, name: string): void => {
    let room: Room;
    try {
      room = getRoom(name);
    } catch (err) {
      logger.error('cannot open room', { room: name, error: errorMessage(err) });
      ws.close(CloseCode.InternalError, 'room unavailable');
      return;
    }
    alive.set(ws, true);
    const client = room.join((bytes) => {
      if (ws.readyState === ws.OPEN) ws.send(bytes);
    });
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        ws.close(CloseCode.UnsupportedData, 'binary messages only');
        return;
      }
      try {
        client.receive(toBytes(data));
      } catch (err) {
        logger.warn('closing client after a malformed message', {
          room: name,
          error: errorMessage(err),
        });
        ws.close(CloseCode.InvalidPayload, 'malformed message');
      }
    });
    ws.on('error', (err) => {
      logger.warn('client socket error', { room: name, error: errorMessage(err) });
    });
    ws.on('close', () => {
      client.leave();
      releaseRoom(room);
    });
  };

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const name = roomFromUrl(req.url);
    if (name === null) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const origin = req.headers.origin ?? '';
    if (options.allowedOrigins && !options.allowedOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, name);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);

  function stats(): ServerStats {
    let clients = 0;
    for (const room of rooms.values()) clients += room.clientCount;
    return { rooms: rooms.size, clients };
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const host = options.host ?? '127.0.0.1';
  logger.info('flock server listening', { host, port, dataDir: options.dataDir });

  return {
    port,
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${port}`,
    stats,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(CloseCode.GoingAway, 'server shutting down');
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      // Give clients a moment to answer the close handshake, then cut the rest.
      const force = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, 1000);
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
      clearTimeout(force);
      http.closeAllConnections();
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
      for (const room of rooms.values()) room.close();
      rooms.clear();
      logger.info('flock server stopped');
    },
  };
}
