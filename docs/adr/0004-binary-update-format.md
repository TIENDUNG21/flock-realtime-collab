# 0004. A purpose-built binary update format

Status: accepted

## Context

Updates travel on every keystroke and are stored in the server log and in `localStorage`. JSON is
easy to inspect but costs about 138 bytes per single-character insert here, and parsing untrusted
JSON still leaves every structural check to the application.

## Decision

Define a versioned binary format (see `docs/ARCHITECTURE.md`): operations grouped by replica with
implicit sequence numbers, delta-coded Lamport times, a string table for replica ids and type names,
header flags for the common cases, and tagged JSON values for map entries. The decoder is written
defensively: every read is bounds-checked, UTF-8 is validated strictly, varints are limited to
2^53 - 1, JSON nesting to 64 levels, and collection counts are checked against the remaining bytes.
Errors are `DecodeError` with a byte offset, and decoded operations pass the same validation as
operations created through the API.

## Consequences

A typed character costs 3 bytes and a random edit about 6 (`npm run bench`). Malformed or hostile
input cannot crash or exhaust a peer; fuzz tests check that only `DecodeError` escapes. The format
needs its own tooling to inspect (`describeMessage` produces the one-line summaries in the
Partition Lab log), and any change requires a new version byte.
