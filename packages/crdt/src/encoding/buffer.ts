import { DecodeError } from '../errors.js';

/** Growable byte buffer with LEB128 varints, signed varints, float64 and strict UTF-8 strings. */
export class Writer {
  #buf = new Uint8Array(64);
  #pos = 0;
  readonly #view8 = new DataView(new ArrayBuffer(8));

  get length(): number {
    return this.#pos;
  }

  #ensure(extra: number): void {
    if (this.#pos + extra <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#pos));
    this.#buf = next;
  }

  u8(value: number): void {
    this.#ensure(1);
    this.#buf[this.#pos++] = value & 0xff;
  }

  /** Unsigned LEB128 varint for integers in [0, 2^53 - 1]. */
  varUint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`varUint needs a non-negative safe integer, got ${value}`);
    }
    this.#ensure(8);
    let v = value;
    while (v >= 0x80) {
      this.#buf[this.#pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.#buf[this.#pos++] = v;
  }

  /**
   * Signed integer in [-(2^53 - 1), 2^53 - 1]. The first byte carries a sign bit and six
   * magnitude bits, so small negative numbers stay one byte long.
   */
  varInt(value: number): void {
    if (!Number.isSafeInteger(value))
      throw new RangeError(`varInt needs a safe integer, got ${value}`);
    this.#ensure(8);
    let magnitude = Math.abs(value);
    const sign = value < 0 || Object.is(value, -0) ? 0x40 : 0;
    const more = magnitude >= 0x40 ? 0x80 : 0;
    this.#buf[this.#pos++] = more | sign | (magnitude % 0x40);
    magnitude = Math.floor(magnitude / 0x40);
    while (magnitude > 0) {
      this.#buf[this.#pos++] = (magnitude >= 0x80 ? 0x80 : 0) | (magnitude % 0x80);
      magnitude = Math.floor(magnitude / 0x80);
    }
  }

  f64(value: number): void {
    this.#ensure(8);
    this.#view8.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.#buf[this.#pos++] = this.#view8.getUint8(i);
  }

  bytes(data: Uint8Array): void {
    this.#ensure(data.length);
    this.#buf.set(data, this.#pos);
    this.#pos += data.length;
  }

  /** Length-prefixed UTF-8 string. Throws TypeError for lone surrogates. */
  string(value: string): void {
    // Worst case: 3 bytes per UTF-16 unit, plus the length prefix.
    this.#ensure(value.length * 3 + 8);
    const lengthAt = this.#pos;
    // Reserve space for the length prefix assuming the common one-byte case; shift if longer.
    this.#pos += 1;
    const start = this.#pos;
    for (let i = 0; i < value.length; i++) {
      let c = value.charCodeAt(i);
      if (c < 0x80) {
        this.#buf[this.#pos++] = c;
      } else if (c < 0x800) {
        this.#buf[this.#pos++] = 0xc0 | (c >> 6);
        this.#buf[this.#pos++] = 0x80 | (c & 0x3f);
      } else if (c >= 0xd800 && c <= 0xdfff) {
        const low = value.charCodeAt(i + 1);
        if (c > 0xdbff || !(low >= 0xdc00 && low <= 0xdfff)) {
          this.#pos = lengthAt;
          throw new TypeError('cannot encode a string with a lone surrogate');
        }
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
        this.#buf[this.#pos++] = 0xf0 | (c >> 18);
        this.#buf[this.#pos++] = 0x80 | ((c >> 12) & 0x3f);
        this.#buf[this.#pos++] = 0x80 | ((c >> 6) & 0x3f);
        this.#buf[this.#pos++] = 0x80 | (c & 0x3f);
      } else {
        this.#buf[this.#pos++] = 0xe0 | (c >> 12);
        this.#buf[this.#pos++] = 0x80 | ((c >> 6) & 0x3f);
        this.#buf[this.#pos++] = 0x80 | (c & 0x3f);
      }
    }
    const byteLength = this.#pos - start;
    if (byteLength < 0x80) {
      this.#buf[lengthAt] = byteLength;
      return;
    }
    const encoded = this.#buf.slice(start, this.#pos);
    this.#pos = lengthAt;
    this.varUint(byteLength);
    this.bytes(encoded);
  }

  /** A copy of the written bytes. */
  finish(): Uint8Array {
    return this.#buf.slice(0, this.#pos);
  }
}

/** Bounds-checked reader. Every failure is a DecodeError carrying the byte offset. */
export class Reader {
  readonly #buf: Uint8Array;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  get offset(): number {
    return this.#pos;
  }

  get remaining(): number {
    return this.#buf.length - this.#pos;
  }

  get done(): boolean {
    return this.#pos >= this.#buf.length;
  }

  fail(message: string, at: number = this.#pos): never {
    throw new DecodeError(message, at);
  }

  u8(): number {
    const value = this.#buf[this.#pos];
    if (value === undefined) this.fail('unexpected end of input');
    this.#pos++;
    return value;
  }

  varUint(): number {
    const start = this.#pos;
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) this.fail('varint exceeds 2^53 - 1', start);
        return value;
      }
      scale *= 0x80;
    }
    return this.fail('varint is longer than 8 bytes', start);
  }

  varInt(): number {
    const start = this.#pos;
    const first = this.u8();
    const negative = (first & 0x40) !== 0;
    let magnitude = first & 0x3f;
    let scale = 0x40;
    let byte = first;
    for (let i = 1; byte >= 0x80; i++) {
      if (i >= 8) this.fail('varint is longer than 8 bytes', start);
      byte = this.u8();
      magnitude += (byte & 0x7f) * scale;
      scale *= 0x80;
    }
    if (!Number.isSafeInteger(magnitude)) this.fail('varint exceeds 2^53 - 1', start);
    return negative ? -magnitude : magnitude;
  }

  f64(): number {
    if (this.remaining < 8) this.fail('unexpected end of input');
    const view = new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#pos, 8);
    this.#pos += 8;
    return view.getFloat64(0, true);
  }

  bytes(length: number): Uint8Array {
    if (length > this.remaining)
      this.fail(`length ${length} exceeds the remaining ${this.remaining} bytes`);
    const out = this.#buf.subarray(this.#pos, this.#pos + length);
    this.#pos += length;
    return out;
  }

  /** Reads a length-prefixed, strictly validated UTF-8 string. */
  string(): string {
    const lengthAt = this.#pos;
    const length = this.varUint();
    if (length > this.remaining) {
      this.fail(`string length ${length} exceeds the remaining ${this.remaining} bytes`, lengthAt);
    }
    const end = this.#pos + length;
    const buf = this.#buf;
    let out = '';
    let i = this.#pos;
    while (i < end) {
      const at = i;
      const b0 = buf[i++] ?? 0;
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        continue;
      }
      let need: number;
      let cp: number;
      let min: number;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1;
        cp = b0 & 0x1f;
        min = 0x80;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2;
        cp = b0 & 0x0f;
        min = 0x800;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3;
        cp = b0 & 0x07;
        min = 0x10000;
      } else {
        this.fail('invalid UTF-8 lead byte', at);
      }
      if (i + need > end) this.fail('truncated UTF-8 sequence', at);
      for (let k = 0; k < need; k++) {
        const b = buf[i++] ?? 0;
        if ((b & 0xc0) !== 0x80) this.fail('invalid UTF-8 continuation byte', at);
        cp = (cp << 6) | (b & 0x3f);
      }
      if (cp < min) this.fail('overlong UTF-8 sequence', at);
      if (cp > 0x10ffff) this.fail('UTF-8 code point above U+10FFFF', at);
      if (cp >= 0xd800 && cp <= 0xdfff) this.fail('UTF-8 encoded surrogate', at);
      out += String.fromCodePoint(cp);
    }
    this.#pos = end;
    return out;
  }
}

/** Upper bound check used before allocating collections: each element needs at least one byte. */
export function checkCount(reader: Reader, count: number, what: string): void {
  if (count > reader.remaining) {
    reader.fail(`${what} count ${count} exceeds the remaining ${reader.remaining} bytes`);
  }
}
