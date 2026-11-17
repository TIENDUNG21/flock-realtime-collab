# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-17

First release.

### Added

- `@flock/crdt`: RGA text with tombstones and relative positions, last-writer-wins map, Lamport and
  vector clocks, per-replica op log with a causal delivery buffer, and a versioned binary update
  format with a bounds-checked decoder. No runtime dependencies.
- `@flock/sync`: four-message protocol (state vector, delta, update, awareness), `SyncSession` with
  outbox, anti-entropy and gap detection, `Awareness` with timeouts, `WebSocketProvider` with
  reconnect backoff, and `SimNetwork`, a seeded network simulator with partitions, latency, loss and
  duplication.
- `apps/server`: WebSocket relay with one replica per room, append-only checksummed log with tail
  repair and compaction, `/health`, room-name validation, optional origin allow-list.
- `apps/web`: collaborative editor with remote carets and selections, shared whiteboard, presence,
  local-first storage, and the Partition Lab, deployed to GitHub Pages.
- Property-based convergence tests, decoder fuzzing, a real-WebSocket integration test, and
  `npm run bench` with results in `bench/results.json`.

[1.0.0]: https://github.com/TIENDUNG21/flock-realtime-collab/releases/tag/v1.0.0
