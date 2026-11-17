/** True when `str` contains no lone (unpaired) UTF-16 surrogates. */
export function isWellFormed(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Splits a well-formed string into code points (each one or two UTF-16 units). */
export function splitCodePoints(str: string): string[] {
  return Array.from(str);
}

/** Number of code points in a well-formed string. */
export function codePointCount(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) i++;
    count++;
  }
  return count;
}

/** True when UTF-16 offset `index` falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(str: string, index: number): boolean {
  if (index <= 0 || index >= str.length) return false;
  const before = str.charCodeAt(index - 1);
  const after = str.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
