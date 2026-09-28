# champ_persistent_map

Immutable hash maps and sets for JavaScript, built from scratch on a **CHAMP** trie
(Compressed Hash Array Mapped Prefix tree). Zero dependencies, plain ES modules, runs on Node 18+.

```js
import { PersistentMap } from './src/index.js';

const v1 = PersistentMap.from({ title: 'Draft', body: 'Hello' });
const v2 = v1.set('title', 'Final');

v1.get('title');   // 'Draft'   (old versions never change)
v2.get('title');   // 'Final'
v1.diff(v2);       // { changed: [['title', 'Draft', 'Final']], added: [], removed: [], visited: 1 }
```

## Why this exists

Immutable data is the backbone of undo stacks, time travel debugging, React style state
management and anything concurrent. The naive way to get it is to copy the whole `Map` on every
write, which is O(n) per edit and falls over quickly (see the benchmark below: 5,000 copy on write
inserts take longer than 200,000 persistent ones).

A hash array mapped trie fixes that by splitting the 32 bit hash of each key into 5 bit chunks and
using them as a path through a tree with up to 32 children per node. An update copies only the
handful of nodes on the path from the root to the key (usually 3 to 5) and shares everything else
with the previous version.

CHAMP (Steindorfer and Vinju, OOPSLA 2015) refines Bagwell's classic HAMT in two ways, and this
project leans on both:

1. **Two bitmaps per node.** `dataMap` marks slots holding an inline key/value pair, `nodeMap` marks
   slots holding a child. Entries and children live in separate dense arrays, so lookups and
   iteration never type test a slot.
2. **Canonical form.** Whenever a deletion leaves a sub trie with a single entry, that entry is
   pulled back up into its parent. As a result, the shape of the tree depends only on *which keys
   are in it*, never on the order they were inserted or deleted. The tests check this explicitly.

Canonical form is what makes the two most interesting features here cheap:

* **Structural equality.** Two maps with the same contents have the same bitmaps at every level,
  so `equals` compares node by node and skips shared subtrees by reference.
* **Structural diff.** `a.diff(b)` walks both trees in lockstep and never descends into a subtree
  that both versions share. Diffing a 100,000 entry map against a version with three edits
  inspects about ten nodes.

## Features

* `PersistentMap` and `PersistentSet` with the usual API: `get`, `has`, `set`, `delete`, `update`,
  `merge`, `filter`, `mapValues`, iteration, `toObject`, JSON support
* Set algebra: `union`, `intersection`, `difference`, `isSubsetOf`
* **Transients**: `withMutations(t => ...)` or `asMutable()` for fast bulk edits. Nodes created
  by the transient are stamped with a private owner token and mutated in place; nodes shared with
  the source are copied on first touch. After `persistent()` the transient refuses further use.
* **No op detection**: any edit that changes nothing returns the exact same instance, so
  `prev === next` is a free "did anything change?" check.
* **Value semantics**: keys use SameValueZero like the built in `Map` (so `NaN` works and `0`/`-0`
  are the same key). Any object implementing both `hashCode()` and `equals()` is compared by value,
  and the collections implement that protocol themselves, so maps can be keys of other maps and
  sets can contain sets.
* Full 32 bit hash collisions are handled by collision buckets below the last trie level, and
  those buckets collapse back into their parent when they shrink to one entry.
* Introspection: `stats()` (node counts, depth, entries per level) and `sharedNodeCount(other)`.

## Running it

No install step is needed; there are no dependencies.

```bash
npm test            # 27 tests using the built in node:test runner
npm run bench       # micro benchmarks (optional arg: number of keys)
npm run example     # undo/redo history demo driven by diff()
```

## API sketch

```js
import { PersistentMap, PersistentSet } from './src/index.js';

let m = PersistentMap.empty().set('a', 1).set('b', 2);
m = m.update('a', (v) => v + 1);          // a: 2
m = m.merge({ c: 3 }, new Map([['d', 4]]));

// Bulk load 100k entries in place, then freeze
const big = PersistentMap.empty().withMutations((t) => {
  for (let i = 0; i < 100_000; i++) t.set(i, i * i);
});

const next = big.set(7, 'seven').delete(8);
const { added, removed, changed, visited } = big.diff(next);

// Value keys
const point = PersistentMap.from({ x: 1, y: 2 });
const labels = PersistentMap.empty().set(point, 'origin');
labels.get(PersistentMap.from({ y: 2, x: 1 })); // 'origin'

const s = PersistentSet.of(1, 2, 3).union([3, 4]).difference([1]); // {2, 3, 4}
```

## Benchmark

`node bench/bench.js` on a modest Linux VM with Node 22, 200,000 string keys:

| operation | time |
|---|---|
| native `Map`, mutable inserts | 40 ms |
| copy on write `Map`, only **5,000** inserts | 700 ms |
| `PersistentMap.set`, a new version per insert | 196 ms |
| `PersistentMap` bulk load via transient | 80 ms |
| 200,000 lookups | 50 ms |
| `equals` on two independently built equal maps | 25 ms |
| `diff` after 3 edits | 0.3 ms (10 nodes visited) |

After a single update, 4 of 50,586 nodes are new; everything else is shared with the previous
version. Entries per depth for 200k keys: `[0, 0, 475, 165117, 33138, 1234, 36]`, which is what
you would expect from a well mixed hash with a branching factor of 32.

## Layout

```
src/hash.js     hashing (FNV 1a + murmur3 finaliser), identity hashes, equality protocol
src/node.js     BitmapNode, CollisionNode, structural equals and diff, stats
src/map.js      PersistentMap and TransientMap
src/set.js      PersistentSet on top of PersistentMap
test/           node:test suites (map, transient, diff, set)
bench/          micro benchmarks
examples/       undo/redo history using diff()
```

## Design notes

* **One node class for both persistent and transient edits.** Every mutating node method takes an
  `owner` argument. `null` means copy on write; a token means "you may edit nodes you own". This
  is the same trick Clojure uses and it keeps the persistent and transient paths from drifting
  apart, since there is only one implementation of the trie logic.
* **Hashing.** Strings use FNV 1a followed by the murmur3 `fmix32` finaliser. FNV alone has weak low
  bits, and the low bits are exactly what the first trie levels consume, so the finaliser matters.
  Objects without `hashCode` get a stable identity id from a `WeakMap`, so using them as keys never
  keeps them alive. Symbols live in a regular `Map` because registered symbols cannot be weak keys.
* **Collisions go all the way down.** Two keys with identical hashes descend through all seven
  levels before landing in a `CollisionNode`. That costs a few extra nodes in a case that should
  almost never happen, and in exchange collision buckets only ever appear at one fixed depth,
  which keeps canonical form, equality and diff simple.
* **Map hash codes** are an order independent sum of per entry hashes, cached on first use, so
  equal maps always hash equally regardless of how they were built.

## Testing approach

The suites combine hand written edge cases with seeded randomised tests (mulberry32 PRNG, so any
failure is reproducible):

* 20,000 random sets/deletes checked step by step against the built in `Map`, including old
  snapshots, which must still reflect the state at the moment they were taken.
* Canonical form: the same key set built in sorted order, shuffled order, and via a detour that
  adds and removes 5,000 extra keys must produce identical `stats()`, `equals` and `hashCode`.
* `diff` is compared against a brute force diff over 30 random edit scripts, in both directions,
  plus targeted cases for collision buckets and for a subtree collapsing into an inline entry.
* Forced collisions via a key class with a constant `hashCode`, and partial collisions that share
  the low 25 bits so the trie has to go five levels deep before diverging.
* Transient isolation: edits never leak into the source map, two transients from the same map are
  independent, and a sealed transient throws.
* Structural sharing is asserted directly: one update on a 50,000 entry map may copy at most
  depth + 1 nodes.

## References

* Michael J. Steindorfer and Jurgen J. Vinju, *Optimizing Hash Array Mapped Tries for Fast and
  Lean Immutable JVM Collections*, OOPSLA 2015.
* Phil Bagwell, *Ideal Hash Trees*, 2001.

## License

MIT
