import type { Doc, Op } from '@flock/crdt';

/** Sends everything `from` has and `to` lacks. */
export function pull(to: Doc, from: Doc): void {
  to.applyOps(from.opsSince(to.stateVector()), from.replicaId);
}

/** Two-way exchange until both sides hold the same history. */
export function syncAll(...docs: Doc[]): void {
  for (const a of docs) for (const b of docs) if (a !== b) pull(a, b);
  for (const a of docs) for (const b of docs) if (a !== b) pull(a, b);
}

/** Everything that must be identical on converged replicas, including tombstone order. */
export function snapshot(doc: Doc): unknown {
  return doc.debugState();
}

/** Records local ops of a doc as they are produced. */
export function recordOps(doc: Doc): Op[] {
  const ops: Op[] = [];
  doc.on('update', (event) => {
    if (event.origin === 'local') ops.push(...event.ops);
  });
  return ops;
}
