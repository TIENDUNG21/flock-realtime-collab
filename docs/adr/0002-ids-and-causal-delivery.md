# 0002. Consecutive sequence numbers, Lamport stamps and a causal buffer

Status: accepted

## Context

Replicas must agree on which operations they have, request exactly the missing ones, and apply
operations only after the operations they depend on. RGA additionally needs a total order that is
consistent with causality to break ties between concurrent inserts.

## Decision

Every operation unit gets two numbers. `seq` counts the replica's own units consecutively
(1, 2, 3, ...); an insert of k code points takes k of them. `lamport` is a Lamport timestamp used
only for ordering. The state vector maps each replica to its highest integrated `seq`. A remote
operation is applied when its `seq` is the next one for its replica and the ids it references are
covered by the state vector; otherwise it waits in a buffer inside `Doc`.

## Consequences

Because `seq` has no gaps, a state vector describes a replica's history exactly, and a delta is a
suffix of each replica's op log, found by binary search. Duplicate detection is a comparison with
the state vector. Buffering lives in the CRDT, so transports can deliver in any order and the
simulator can drop, duplicate and reorder freely. The cost is that a replica id must never be
reused for two independent histories: two copies issuing the same `(replica, seq)` for different
operations would diverge. Clients therefore generate a fresh id per session.
