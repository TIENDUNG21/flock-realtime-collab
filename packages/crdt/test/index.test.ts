import { describe, expect, it } from 'vitest';
import { UPDATE_FORMAT_VERSION } from '@flock/crdt';

describe('@flock/crdt', () => {
  it('exposes the binary update format version', () => {
    expect(UPDATE_FORMAT_VERSION).toBe(1);
  });
});
