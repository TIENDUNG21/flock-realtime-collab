import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION } from '@flock/crdt';

describe('@flock/crdt', () => {
  it('exposes the binary format version', () => {
    expect(FORMAT_VERSION).toBe(1);
  });
});
