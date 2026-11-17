# 0003. Persist rooms as an append-only log of updates

Status: accepted

## Context

The server must survive restarts and crashes without losing acknowledged edits, and must be able to
answer any client's state vector with a delta. It runs as a single Node process with local disk.

## Decision

The server keeps a full replica per room. Every update that adds new operations is appended to
`<room>.flog` as `[u32 length][u32 crc32][payload]`. Opening the log replays all intact records and
truncates a torn or corrupt tail. When the log reaches `FLOCK_COMPACT_EVERY` records (1000 by
default) it is rewritten as a single snapshot update via a temporary file, fsync and rename.

## Consequences

Appends are sequential writes of the bytes already on the wire, with no serialisation step and no
external database. A crash can only lose the record being written. Compaction keeps replay time
proportional to the operation count rather than to the number of messages, but it does not discard
history: the snapshot still contains every operation and tombstone. Appends are not fsynced by
default, so a power loss can lose the last writes that the OS had buffered; `FLOCK_FSYNC=1` trades
throughput for durability. There is no replication between servers.
