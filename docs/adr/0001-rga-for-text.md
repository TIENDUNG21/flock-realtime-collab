# 0001. RGA for the text type

Status: accepted

## Context

The text CRDT has to converge under any delivery order, keep one user's typed words together, and
be small enough to implement, test and explain completely. The main families are position-based
sequences with dense identifiers (Logoot, LSEQ), linked-list sequences with tombstones (RGA, YATA as
used by Yjs), and newer designs aimed at interleaving (Fugue).

## Decision

Use RGA (Roh et al., 2011): every character references the character it was typed after, and
concurrent siblings are ordered by `(Lamport time, replica id)` descending. Store one item per code
point in a linked list, indexed by id.

## Consequences

Identifiers stay a fixed size (`replica`, `seq`) instead of growing with the document, as dense
identifiers can. Text typed forwards by two users at the same place does not interleave, because
each character's origin is the previous one. Text typed backwards at the same place does interleave
(Kleppmann et al., 2019); this is accepted and pinned by a test. Deleted characters must remain as
tombstones because later inserts may reference them, so memory grows with the history and not only
with the visible text. Finding an offset is a list walk; a balanced tree over items would be
needed for O(log n) local edits.
