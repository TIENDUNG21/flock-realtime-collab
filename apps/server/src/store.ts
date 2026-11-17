import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32 } from './crc32.js';
import { isValidRoomName } from './validate.js';

/** File header: "FLOG" + format version. */
const MAGIC = Uint8Array.from([0x46, 0x4c, 0x4f, 0x47, 0x01]);
const RECORD_HEADER = 8;

/** The file exists but is not a Flock log (wrong magic or version); it is left untouched. */
export class StoreFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreFormatError';
  }
}

export interface OpenedStore {
  readonly store: LogStore;
  /** Payloads of every intact record, oldest first. */
  readonly records: Uint8Array[];
  /** True when a torn or corrupt tail was cut off while opening. */
  readonly repaired: boolean;
}

export interface LogStoreOptions {
  /** fsync after every append (survives power loss, slower). Default false. */
  readonly fsync?: boolean;
}

function recordBytes(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(RECORD_HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, crc32(payload), true);
  out.set(payload, RECORD_HEADER);
  return out;
}

/**
 * Append-only log of binary updates for one room: `<dir>/<room>.flog`.
 *
 * Layout: magic, then records `[u32 length][u32 crc32][payload]` (little endian). A crash can
 * only leave a partial record at the end; opening the log keeps every intact record and cuts
 * the file back to the last good one. Compaction writes a snapshot to a temporary file and
 * atomically renames it over the log.
 */
export class LogStore {
  readonly path: string;
  readonly #fsync: boolean;
  #fd: number;
  #records: number;

  private constructor(path: string, fd: number, records: number, fsync: boolean) {
    this.path = path;
    this.#fd = fd;
    this.#records = records;
    this.#fsync = fsync;
  }

  static open(dir: string, room: string, options: LogStoreOptions = {}): OpenedStore {
    if (!isValidRoomName(room)) throw new TypeError(`invalid room name: ${room}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${room}.flog`);
    const records: Uint8Array[] = [];
    let repaired = false;
    if (existsSync(path)) {
      const data = readFileSync(path);
      if (data.length < MAGIC.length || MAGIC.some((b, i) => data[i] !== b)) {
        throw new StoreFormatError(`${path} is not a Flock log (bad header)`);
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let offset = MAGIC.length;
      while (offset < data.length) {
        if (data.length - offset < RECORD_HEADER) break;
        const length = view.getUint32(offset, true);
        const checksum = view.getUint32(offset + 4, true);
        const start = offset + RECORD_HEADER;
        if (length > data.length - start) break;
        const payload = data.subarray(start, start + length);
        if (crc32(payload) !== checksum) break;
        records.push(Uint8Array.from(payload));
        offset = start + length;
      }
      if (offset < data.length) {
        repaired = true;
        const fd = openSync(path, 'r+');
        ftruncateSync(fd, offset);
        fsyncSync(fd);
        closeSync(fd);
      }
    } else {
      const fd = openSync(path, 'w');
      writeSync(fd, MAGIC);
      fsyncSync(fd);
      closeSync(fd);
    }
    const store = new LogStore(path, openSync(path, 'a'), records.length, options.fsync ?? false);
    return { store, records, repaired };
  }

  get recordCount(): number {
    return this.#records;
  }

  append(payload: Uint8Array): void {
    writeSync(this.#fd, recordBytes(payload));
    if (this.#fsync) fsyncSync(this.#fd);
    this.#records++;
  }

  /** Replaces the whole log with one snapshot record (atomic via rename). */
  compact(snapshot: Uint8Array): void {
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w');
    writeSync(fd, MAGIC);
    writeSync(fd, recordBytes(snapshot));
    fsyncSync(fd);
    closeSync(fd);
    closeSync(this.#fd);
    renameSync(tmp, this.path);
    this.#fd = openSync(this.path, 'a');
    this.#records = 1;
  }

  close(): void {
    if (this.#fd < 0) return;
    fsyncSync(this.#fd);
    closeSync(this.#fd);
    this.#fd = -1;
  }
}
