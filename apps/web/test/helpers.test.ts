import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '../src/shared/base64.js';
import { PEER_COLORS, colorFor } from '../src/shared/colors.js';
import { initials, parsePresence } from '../src/editor/presence.js';

describe('base64', () => {
  it('round-trips arbitrary bytes and matches the standard encoding', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const text = toBase64(bytes);
        expect(text).toBe(Buffer.from(bytes).toString('base64'));
        expect(fromBase64(text)).toEqual(bytes);
      }),
    );
  });

  it('rejects malformed input', () => {
    expect(() => fromBase64('abc')).toThrow(TypeError);
    expect(() => fromBase64('ab$=')).toThrow(TypeError);
    expect(() => fromBase64('a=bc')).toThrow(TypeError);
  });
});

describe('colorFor', () => {
  it('is stable and always picks from the palette', () => {
    expect(colorFor('alice')).toBe(colorFor('alice'));
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(PEER_COLORS).toContain(colorFor(id));
      }),
    );
  });
});

describe('parsePresence', () => {
  const valid = {
    name: '  Linh Tran  ',
    color: '#2dd4bf',
    selection: {
      anchor: { anchor: { replica: 'a', seq: 3 }, side: 'right' },
      head: { anchor: null, side: 'left' },
    },
    pointer: { x: 10, y: 20 },
  };

  it('accepts a full presence state and trims the name', () => {
    expect(parsePresence(valid)).toEqual({ ...valid, name: 'Linh Tran' });
  });

  it('drops invalid optional parts but keeps the participant', () => {
    const p = parsePresence({ ...valid, selection: { anchor: 'x' }, pointer: { x: 'a', y: 1 } });
    expect(p).toMatchObject({ name: 'Linh Tran', selection: null, pointer: null });
  });

  it('rejects states without a usable name or color', () => {
    expect(parsePresence({ name: 'x', color: 'javascript:alert(1)' })).toBeNull();
    expect(parsePresence({ color: '#ffffff' })).toBeNull();
    expect(parsePresence(null)).toBeNull();
    expect(parsePresence('string')).toBeNull();
  });

  it('limits name length and falls back for blank names', () => {
    expect(parsePresence({ ...valid, name: 'x'.repeat(100) })?.name).toHaveLength(32);
    expect(parsePresence({ ...valid, name: '   ' })?.name).toBe('Anonymous');
  });
});

describe('initials', () => {
  it('uses the first and last word, including Vietnamese and astral characters', () => {
    expect(initials('Phạm Tiến Dũng')).toBe('PD');
    expect(initials('ana')).toBe('A');
    expect(initials('\u{1F600} bot')).toBe('\u{1F600}B');
    expect(initials('')).toBe('?');
  });
});
