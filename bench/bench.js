// Rough micro-benchmarks. Numbers vary by machine; the point is the shape:
//  * persistent inserts cost O(log32 n) copies instead of O(n) for copy-on-write,
//  * transients close most of the gap to a mutable Map for bulk loads,
//  * diff between versions is proportional to the edit, not the map size.
import { PersistentMap } from '../src/index.js';

function time(label, fn) {
  const t0 = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label.padEnd(52)} ${ms.toFixed(1).padStart(9)} ms`);
  return result;
}

const N = Number(process.argv[2] || 200000);
const keys = Array.from({ length: N }, (_, i) => 'user:' + i);
console.log(`N = ${N.toLocaleString()} string keys\n`);

time('native Map, mutable set', () => {
  const m = new Map();
  for (const k of keys) m.set(k, 1);
  return m;
});

const COW = Math.min(N, 5000);
time(`copy-on-write Map (new Map(old)) x ${COW.toLocaleString()}`, () => {
  let m = new Map();
  for (let i = 0; i < COW; i++) {
    m = new Map(m);
    m.set(keys[i], 1);
  }
  return m;
});

let persistent = time('PersistentMap.set, one version per insert', () => {
  let m = PersistentMap.empty();
  for (const k of keys) m = m.set(k, 1);
  return m;
});

const bulk = time('PersistentMap via withMutations (transient)', () =>
  PersistentMap.empty().withMutations((t) => {
    for (const k of keys) t.set(k, 1);
  }),
);

time('PersistentMap.get x N', () => {
  let hits = 0;
  for (const k of keys) if (bulk.get(k) === 1) hits++;
  return hits;
});

time('structural equals (independently built, equal maps)', () => persistent.equals(bulk));

const edited = bulk.set('user:17', 2).delete('user:99').set('new', 3);
const d = time('diff after 3 edits', () => bulk.diff(edited));
console.log(`  -> ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.visited} nodes visited`);

const { shared, total } = bulk.sharedNodeCount(bulk.set('user:17', 2));
console.log(`\nAfter one update: ${total - shared} of ${total.toLocaleString()} nodes copied, rest shared.`);
const s = bulk.stats();
console.log(`Tree: ${s.bitmapNodes.toLocaleString()} nodes, max depth ${s.maxDepth}, entries per depth ${JSON.stringify(s.entriesByDepth)}`);
