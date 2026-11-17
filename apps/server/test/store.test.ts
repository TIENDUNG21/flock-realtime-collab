import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32 } from '../src/crc32.js';
import { LogStore, StoreFormatError } from '../src/store.js';
import { isValidRoomName } from '../src/validate.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flock-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('isValidRoomName', () => {
  it.each(['notes', 'team-42', 'A_b-C', 'x'.repeat(64)])('accepts %s', (name) => {
    expect(isValidRoomName(name)).toBe(true);
  });
  it.each(['', '../etc', 'a/b', 'a b', 'x'.repeat(65), 'tên', 'con.flog'])('rejects %s', (name) => {
    expect(isValidRoomName(name)).toBe(false);
  });
});

describe('LogStore', () => {
  it('replays appended records after reopening', () => {
    const { store } = LogStore.open(dir, 'room');
    store.append(bytes(1, 2, 3));
    store.append(bytes(4));
    store.close();
    const reopened = LogStore.open(dir, 'room');
    expect(reopened.records).toEqual([bytes(1, 2, 3), bytes(4)]);
    expect(reopened.repaired).toBe(false);
    expect(reopened.store.recordCount).toBe(2);
    reopened.store.close();
  });

  it('starts empty for a new room', () => {
    const { store, records } = LogStore.open(dir, 'fresh');
    expect(records).toEqual([]);
    store.close();
  });

  it('drops a torn last record and truncates the file', () => {
    const { store } = LogStore.open(dir, 'room');
    store.append(bytes(1, 1, 1));
    store.append(bytes(2, 2, 2, 2, 2));
    store.close();
    const file = join(dir, 'room.flog');
    const size = statSync(file).size;
    truncateSync(file, size - 2);
    const reopened = LogStore.open(dir, 'room');
    expect(reopened.records).toEqual([bytes(1, 1, 1)]);
    expect(reopened.repaired).toBe(true);
    reopened.store.append(bytes(3));
    reopened.store.close();
    expect(LogStore.open(dir, 'room').records).toEqual([bytes(1, 1, 1), bytes(3)]);
  });

  it('drops a record whose checksum does not match', () => {
    const { store } = LogStore.open(dir, 'room');
    store.append(bytes(7, 7));
    store.append(bytes(8, 8));
    store.close();
    const file = join(dir, 'room.flog');
    const data = readFileSync(file);
    data[data.length - 1] = 0xff;
    writeFileSync(file, data);
    const reopened = LogStore.open(dir, 'room');
    expect(reopened.records).toEqual([bytes(7, 7)]);
    expect(reopened.repaired).toBe(true);
    reopened.store.close();
  });

  it('refuses to open a file that is not a Flock log', () => {
    writeFileSync(join(dir, 'room.flog'), 'hello world, not a log');
    expect(() => LogStore.open(dir, 'room')).toThrow(StoreFormatError);
  });

  it('compacts to a single snapshot record and keeps appending after it', () => {
    const { store } = LogStore.open(dir, 'room');
    for (let i = 0; i < 10; i++) store.append(bytes(i));
    store.compact(bytes(42, 42));
    expect(store.recordCount).toBe(1);
    store.append(bytes(43));
    store.close();
    const reopened = LogStore.open(dir, 'room');
    expect(reopened.records).toEqual([bytes(42, 42), bytes(43)]);
    reopened.store.close();
  });

  it('rejects invalid room names before touching the disk', () => {
    expect(() => LogStore.open(dir, '../escape')).toThrow(TypeError);
  });
});
