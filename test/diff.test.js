import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentMap } from '../src/index.js';
import { rng, BadKey } from './helpers.js';

function bruteDiff(a, b) {
  const added = [], removed = [], changed = [];
  for (const [k, v] of a) {
    if (!b.has(k)) removed.push([k, v]);
    else if (b.get(k) !== v) changed.push([k, v, b.get(k)]);
  }
  for (const [k, v] of b) if (!a.has(k)) added.push([k, v]);
  return { added, removed, changed };
}

const norm = (list) => list.map((e) => JSON.stringify(e.map(String))).sort();

function assertSameDiff(actual, expected) {
  assert.deepEqual(norm(actual.added), norm(expected.added));
  assert.deepEqual(norm(actual.removed), norm(expected.removed));
  assert.deepEqual(norm(actual.changed), norm(expected.changed));
}

test('diff matches a brute-force diff on random edit scripts', () => {
  const rand = rng(7);
  for (let round = 0; round < 30; round++) {
    let a = PersistentMap.empty();
    const n = 1 + Math.floor(rand() * 3000);
    for (let i = 0; i < n; i++) a = a.set(Math.floor(rand() * 5000), Math.floor(rand() * 5));
    let b = a;
    const edits = Math.floor(rand() * 400);
    for (let i = 0; i < edits; i++) {
      const k = Math.floor(rand() * 5000);
      b = rand() < 0.5 ? b.set(k, Math.floor(rand() * 5)) : b.delete(k);
    }
    assertSameDiff(a.diff(b), bruteDiff(a, b));
    assertSameDiff(b.diff(a), bruteDiff(b, a));
  }
});

test('diff of unrelated maps (no shared structure) is still correct', () => {
  const a = PersistentMap.from(Array.from({ length: 800 }, (_, i) => [i, i]));
  const b = PersistentMap.from(Array.from({ length: 800 }, (_, i) => [i + 400, i + 400 === 500 ? 'x' : i + 400]));
  assertSameDiff(a.diff(b), bruteDiff(a, b));
});

test('diff cost is proportional to the change, not the map', () => {
  const big = PersistentMap.from(Array.from({ length: 100000 }, (_, i) => [i, i]));
  const edited = big.set(42, 'changed').delete(77).set(-1, 'new');
  const d = big.diff(edited);
  assert.deepEqual(d.changed, [[42, 42, 'changed']]);
  assert.deepEqual(d.removed, [[77, 77]]);
  assert.deepEqual(d.added, [[-1, 'new']]);
  assert.ok(d.visited < 40, `visited ${d.visited} nodes`);
  assert.equal(big.diff(big).visited, 0);
});

test('diff handles collision buckets', () => {
  const a = PersistentMap.from(Array.from({ length: 6 }, (_, i) => [new BadKey(i), i]));
  const b = a.delete(new BadKey(0)).set(new BadKey(1), 'one').set(new BadKey(9), 9);
  const d = a.diff(b);
  assert.deepEqual(d.removed.map(([k]) => k.id), [0]);
  assert.deepEqual(d.changed.map(([k, x, y]) => [k.id, x, y]), [[1, 1, 'one']]);
  assert.deepEqual(d.added.map(([k]) => k.id), [9]);
});

test('diff where a subtree collapses into an inline entry', () => {
  // Two keys sharing the first fragment force a sub-node; deleting one inlines the other.
  const k1 = new BadKey('a', 0b00001), k2 = new BadKey('b', 0b100001);
  const a = PersistentMap.from([[k1, 1], [k2, 2]]);
  const b = a.delete(k2).set(k1, 10);
  const d = a.diff(b);
  assert.deepEqual(d.removed.map(([k]) => k.id), ['b']);
  assert.deepEqual(d.changed.map(([k, x, y]) => [k.id, x, y]), [['a', 1, 10]]);
  const back = b.diff(a);
  assert.deepEqual(back.added.map(([k]) => k.id), ['b']);
  assert.deepEqual(back.changed.map(([k, x, y]) => [k.id, x, y]), [['a', 10, 1]]);
});
