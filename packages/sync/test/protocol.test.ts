import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DecodeError, Doc, VectorClock } from '@flock/crdt';
import { describeMessage, decodeMessage, encodeMessage, type Message } from '@flock/sync';

const update = (): Uint8Array => {
  const doc = new Doc({ replicaId: 'a' });
  doc.getText('t').insert(0, 'hi');
  return doc.encodeStateAsUpdate();
};

describe('protocol messages', () => {
  const samples: Message[] = [
    { type: 'sync-step1', stateVector: VectorClock.from({ a: 3, b: 1 }) },
    { type: 'sync-step2', update: update() },
    { type: 'update', update: update() },
    {
      type: 'awareness',
      entries: [
        { replica: 'a', clock: 4, state: { name: 'Ana', cursor: { anchor: null } } },
        { replica: 'b', clock: 9, state: null },
      ],
    },
  ];

  it.each(samples)('round-trips $type', (msg) => {
    const decoded = decodeMessage(encodeMessage(msg));
    if (msg.type === 'sync-step1' && decoded.type === 'sync-step1') {
      expect(decoded.stateVector.toJSON()).toEqual(msg.stateVector.toJSON());
    } else {
      expect(decoded).toEqual(msg);
    }
  });

  it('describes messages for logs', () => {
    expect(describeMessage(encodeMessage(samples[0] as Message))).toBe('sync-step1 (2 replicas)');
    expect(describeMessage(encodeMessage(samples[2] as Message))).toBe('update (1 op)');
    expect(describeMessage(encodeMessage(samples[3] as Message))).toBe('awareness (2 peers)');
    expect(describeMessage(Uint8Array.of(42))).toBe('malformed message');
  });

  it('rejects empty, unknown and truncated messages with DecodeError', () => {
    expect(() => decodeMessage(new Uint8Array(0))).toThrow(DecodeError);
    expect(() => decodeMessage(Uint8Array.of(77))).toThrow(/unknown message type/);
    for (const msg of samples) {
      const bytes = encodeMessage(msg);
      for (let end = 1; end < bytes.length; end++) {
        expect(() => decodeMessage(bytes.subarray(0, end))).toThrow(DecodeError);
      }
    }
  });

  it('never throws anything but DecodeError for random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 40 }), (bytes) => {
        try {
          decodeMessage(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
