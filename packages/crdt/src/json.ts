/** A JSON value. Map entries hold these; nested CRDTs are not supported. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Maximum nesting depth accepted for JSON values (protects the encoder and decoder stacks). */
export const MAX_JSON_DEPTH = 64;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates `value` as JSON and returns a deep, frozen copy. Throws a TypeError naming the
 * offending path for non-finite numbers, `undefined`, functions, symbols, bigints, cycles and
 * non-plain objects (Date, Map, class instances).
 */
export function freezeJson(value: unknown): Json {
  const seen = new Set<object>();
  const visit = (v: unknown, path: string, depth: number): Json => {
    if (depth > MAX_JSON_DEPTH)
      throw new TypeError(`JSON value nested deeper than ${MAX_JSON_DEPTH} at ${path}`);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new TypeError(`non-finite number at ${path}`);
      return v;
    }
    if (typeof v !== 'object') throw new TypeError(`${typeof v} is not a JSON value (at ${path})`);
    if (seen.has(v)) throw new TypeError(`cyclic value at ${path}`);
    seen.add(v);
    let out: Json;
    if (Array.isArray(v)) {
      out = Object.freeze(v.map((item: unknown, i) => visit(item, `${path}[${i}]`, depth + 1)));
    } else {
      if (!isPlainObject(v)) throw new TypeError(`only plain objects are JSON values (at ${path})`);
      const copy: Record<string, Json> = {};
      for (const [key, item] of Object.entries(v)) {
        Object.defineProperty(copy, key, {
          value: visit(item, `${path}.${key}`, depth + 1),
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      out = Object.freeze(copy);
    }
    seen.delete(v);
    return out;
  };
  return visit(value, '$', 0);
}
