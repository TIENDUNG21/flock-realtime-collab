/** One contiguous edit: remove `remove` units at `index`, then insert `insert` there. */
export interface Splice {
  readonly index: number;
  readonly remove: number;
  readonly insert: string;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * Describes the change from `before` to `after` as a single splice (a textarea `input` event
 * changes one contiguous region). `caret` is the selection end after the edit; it resolves the
 * ambiguity when the edit happens inside a run of equal characters ("aa" -> "aaa"). Offsets
 * never fall between the two halves of a surrogate pair.
 */
export function diffSplice(before: string, after: string, caret?: number): Splice {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (caret !== undefined) {
    const grown = Math.max(0, after.length - before.length);
    prefix = Math.min(prefix, Math.max(0, caret - grown));
  }
  if (prefix > 0 && isHigh(before.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  const maxSuffix = max - prefix;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLow(before.charCodeAt(before.length - suffix))) suffix--;

  return {
    index: prefix,
    remove: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

export function applySplice(text: string, splice: Splice): string {
  return text.slice(0, splice.index) + splice.insert + text.slice(splice.index + splice.remove);
}
