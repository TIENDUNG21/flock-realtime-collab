import { MAX_JSON_DEPTH, type Json } from '../json.js';
import { checkCount, type Reader, type Writer } from './buffer.js';

/** One-byte type tags. */
const Tag = {
  Null: 0,
  False: 1,
  True: 2,
  Int: 3,
  Float: 4,
  String: 5,
  Array: 6,
  Object: 7,
} as const;

/** Writes a JSON value with a one-byte type tag. Safe integers use signed varints. */
export function writeJson(w: Writer, value: Json, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`JSON nested deeper than ${MAX_JSON_DEPTH}`);
  if (value === null) {
    w.u8(Tag.Null);
  } else if (value === false) {
    w.u8(Tag.False);
  } else if (value === true) {
    w.u8(Tag.True);
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
      w.u8(Tag.Int);
      w.varInt(value);
    } else {
      w.u8(Tag.Float);
      w.f64(value);
    }
  } else if (typeof value === 'string') {
    w.u8(Tag.String);
    w.string(value);
  } else if (Array.isArray(value)) {
    const items = value as readonly Json[];
    w.u8(Tag.Array);
    w.varUint(items.length);
    for (const item of items) writeJson(w, item, depth + 1);
  } else {
    const entries = Object.entries(value as Record<string, Json>);
    w.u8(Tag.Object);
    w.varUint(entries.length);
    for (const [key, item] of entries) {
      w.string(key);
      writeJson(w, item, depth + 1);
    }
  }
}

export function readJson(r: Reader, depth = 0): Json {
  const at = r.offset;
  if (depth > MAX_JSON_DEPTH) r.fail(`JSON nested deeper than ${MAX_JSON_DEPTH}`, at);
  const tag = r.u8();
  switch (tag) {
    case Tag.Null:
      return null;
    case Tag.False:
      return false;
    case Tag.True:
      return true;
    case Tag.Int:
      return r.varInt();
    case Tag.Float: {
      const value = r.f64();
      if (!Number.isFinite(value)) r.fail('non-finite number in JSON value', at);
      return value;
    }
    case Tag.String:
      return r.string();
    case Tag.Array: {
      const count = r.varUint();
      checkCount(r, count, 'array');
      const items: Json[] = [];
      for (let i = 0; i < count; i++) items.push(readJson(r, depth + 1));
      return items;
    }
    case Tag.Object: {
      const count = r.varUint();
      checkCount(r, count, 'object');
      const out: Record<string, Json> = {};
      for (let i = 0; i < count; i++) {
        const key = r.string();
        // defineProperty keeps keys such as "__proto__" as plain own properties.
        Object.defineProperty(out, key, {
          value: readJson(r, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      return r.fail(`unknown JSON tag ${tag}`, at);
  }
}
