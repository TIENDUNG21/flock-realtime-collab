// Throughput and encoding-size benchmarks for @flock/crdt and @flock/sync.
// Usage: npm run bench  (writes bench/results.json and prints a Markdown table)
import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Doc, decodeUpdate, encodeStateVector, encodeUpdate, type Op } from '@flock/crdt';
import { SyncSession } from '@flock/sync';

const RUNS = 5;

/** Seeded generator so every run edits the same positions. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Result {
  readonly name: string;
  readonly ops: number;
  readonly medianMs: number;
  readonly opsPerSec: number;
}

/** One warm-up run, then the median of RUNS timed runs. `setup` is not timed. */
function measure<T>(name: string, ops: number, setup: () => T, body: (input: T) => void): Result {
  body(setup());
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const input = setup();
    const start = performance.now();
    body(input);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)] ?? 0;
  return { name, ops, medianMs, opsPerSec: Math.round((ops / medianMs) * 1000) };
}

function collect(doc: Doc): Op[] {
  const ops: Op[] = [];
  doc.on('update', (e) => ops.push(...e.ops));
  return ops;
}

/** Types `n` characters one keystroke at a time at the end of the text. */
function typingTrace(n: number, replica = 'typist'): { doc: Doc; ops: Op[] } {
  const doc = new Doc({ replicaId: replica });
  const ops = collect(doc);
  const text = doc.getText('t');
  for (let i = 0; i < n; i++) text.insert(i, String.fromCharCode(97 + (i % 26)));
  return { doc, ops };
}

/** Single-character inserts and deletes at random positions (70% inserts). */
function randomTrace(n: number, seed: number, replica = 'editor'): { doc: Doc; ops: Op[] } {
  const random = rng(seed);
  const doc = new Doc({ replicaId: replica });
  const ops = collect(doc);
  const text = doc.getText('t');
  for (let i = 0; i < n; i++) {
    if (text.length > 0 && random() < 0.3) text.delete(Math.floor(random() * text.length), 1);
    else text.insert(Math.floor(random() * (text.length + 1)), 'x');
  }
  return { doc, ops };
}

const results: Result[] = [];
const TYPING = 100_000;
const RANDOM = 20_000;

results.push(
  measure(
    'local typing, append (100k keystrokes)',
    TYPING,
    () => null,
    () => {
      typingTrace(TYPING);
    },
  ),
);

results.push(
  measure(
    'local random inserts/deletes (20k on a growing text)',
    RANDOM,
    () => null,
    () => {
      randomTrace(RANDOM, 7);
    },
  ),
);

const typed = typingTrace(TYPING);
const typedUpdate = encodeUpdate(typed.ops);
results.push(
  measure(
    'encode 100k typing ops',
    TYPING,
    () => null,
    () => {
      encodeUpdate(typed.ops);
    },
  ),
);
results.push(
  measure(
    'decode 100k typing ops',
    TYPING,
    () => null,
    () => {
      decodeUpdate(typedUpdate);
    },
  ),
);
results.push(
  measure(
    'apply remote update, 100k typing ops (decode + integrate)',
    TYPING,
    () => new Doc({ replicaId: 'reader' }),
    (doc) => {
      doc.applyUpdate(typedUpdate);
    },
  ),
);

// Three replicas edit the same 1k-character base concurrently, then one merges the others.
const base = typingTrace(1_000, 'base');
const branches = ['r1', 'r2', 'r3'].map((replica, i) => {
  const doc = new Doc({ replicaId: replica });
  doc.applyUpdate(base.doc.encodeStateAsUpdate());
  const ops = collect(doc);
  const random = rng(100 + i);
  const text = doc.getText('t');
  for (let k = 0; k < 10_000; k++) {
    if (random() < 0.25) text.delete(Math.floor(random() * text.length), 1);
    else text.insert(Math.floor(random() * (text.length + 1)), 'y');
  }
  return { doc, update: encodeUpdate(ops), ops: ops.length };
});
const mergeOps = branches.slice(1).reduce((n, b) => n + b.ops, 0);
results.push(
  measure(
    'merge 2 concurrent branches into a third (20k ops)',
    mergeOps,
    () => {
      const doc = new Doc({ replicaId: 'merger' });
      doc.applyUpdate(branches[0]?.doc.encodeStateAsUpdate() ?? new Uint8Array());
      return doc;
    },
    (doc) => {
      for (const b of branches.slice(1)) doc.applyUpdate(b.update);
    },
  ),
);

results.push(
  measure(
    'map set, 100k writes over 1k keys',
    100_000,
    () => new Doc({ replicaId: 'm' }),
    (doc) => {
      const map = doc.getMap('m');
      for (let i = 0; i < 100_000; i++) map.set(`k${i % 1000}`, i);
    },
  ),
);

// End to end: every keystroke on A becomes an `update` message that B decodes and applies.
results.push(
  measure(
    'replicate keystrokes A to B through SyncSession (20k)',
    20_000,
    () => {
      const a = new Doc({ replicaId: 'a' });
      const b = new Doc({ replicaId: 'b' });
      const sb: { session?: SyncSession } = {};
      const sa = new SyncSession(a, { antiEntropyMs: 0, send: (m) => sb.session?.receive(m) });
      sb.session = new SyncSession(b, {
        antiEntropyMs: 0,
        send: (m) => {
          sa.receive(m);
        },
      });
      sa.connect();
      sb.session.connect();
      return { a, b };
    },
    ({ a, b }) => {
      const text = a.getText('t');
      for (let i = 0; i < 20_000; i++) text.insert(i, 'z');
      if (b.getText('t').length !== 20_000) throw new Error('replication incomplete');
    },
  ),
);

// Encoded sizes.
const random = randomTrace(RANDOM, 7);
const randomUpdate = encodeUpdate(random.ops);
const jsonBytes = (ops: readonly Op[]): number => Buffer.byteLength(JSON.stringify(ops));
const tombstoned = typingTrace(TYPING, 'writer');
tombstoned.doc.getText('t').delete(0, TYPING / 2);
const sizes = {
  typing: {
    ops: typed.ops.length,
    binaryBytes: typedUpdate.length,
    jsonBytes: jsonBytes(typed.ops),
    bytesPerOp: +(typedUpdate.length / typed.ops.length).toFixed(2),
  },
  randomEdits: {
    ops: random.ops.length,
    binaryBytes: randomUpdate.length,
    jsonBytes: jsonBytes(random.ops),
    bytesPerOp: +(randomUpdate.length / random.ops.length).toFixed(2),
  },
  tombstones: {
    visibleChars: tombstoned.doc.getText('t').length,
    fullStateBytes: tombstoned.doc.encodeStateAsUpdate().length,
  },
  mergedDoc: {
    replicas: 4,
    stateVectorBytes: encodeStateVector(branches[0]?.doc.stateVector() ?? typed.doc.stateVector())
      .length,
  },
};

const machine = {
  cpu: cpus()[0]?.model.trim() ?? 'unknown',
  threads: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  os: `${platform()} ${release()}`,
  node: process.version,
};

writeFileSync(
  new URL('../results.json', import.meta.url),
  `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), machine, runs: RUNS, results, sizes }, null, 2)}\n`,
);

const fmt = (n: number): string => n.toLocaleString('en-US');
console.info(
  `Machine: ${machine.cpu}, ${machine.memoryGiB} GiB, ${machine.os}, Node ${machine.node}`,
);
console.info(`Median of ${RUNS} runs after one warm-up.\n`);
console.info('| Benchmark | Ops | Median | Ops/s |');
console.info('| --- | ---: | ---: | ---: |');
for (const r of results) {
  console.info(`| ${r.name} | ${fmt(r.ops)} | ${r.medianMs.toFixed(1)} ms | ${fmt(r.opsPerSec)} |`);
}
console.info('\n| Trace | Ops | Binary | JSON | Bytes/op |');
console.info('| --- | ---: | ---: | ---: | ---: |');
for (const [name, s] of [
  ['typing', sizes.typing],
  ['random edits', sizes.randomEdits],
] as const) {
  console.info(
    `| ${name} | ${fmt(s.ops)} | ${fmt(s.binaryBytes)} B | ${fmt(s.jsonBytes)} B | ${s.bytesPerOp} |`,
  );
}
console.info(
  `\nAfter typing ${fmt(TYPING)} characters and deleting half: ${fmt(sizes.tombstones.visibleChars)} visible characters, full state ${fmt(sizes.tombstones.fullStateBytes)} B.`,
);
