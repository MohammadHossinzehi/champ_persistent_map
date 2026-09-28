import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentSet, PersistentMap } from '../src/index.js';

test('set basics and immutability', () => {
  const s = PersistentSet.of(1, 2, 3);
  const s2 = s.add(4).delete(1);
  assert.deepEqual(s.toArray().sort(), [1, 2, 3]);
  assert.deepEqual(s2.toArray().sort(), [2, 3, 4]);
  assert.equal(s.add(2), s);
  assert.equal(s.delete(99), s);
  assert.equal(PersistentSet.of(1).delete(1), PersistentSet.empty());
});

test('algebra: union, intersection, difference, subset', () => {
  const a = PersistentSet.from([1, 2, 3, 4]);
  const b = PersistentSet.from([3, 4, 5]);
  assert.deepEqual(a.union(b).toArray().sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(a.intersection(b).toArray().sort(), [3, 4]);
  assert.deepEqual(a.difference(b).toArray().sort(), [1, 2]);
  assert.ok(PersistentSet.of(3, 4).isSubsetOf(a));
  assert.ok(!b.isSubsetOf(a));
  assert.equal(a.union([]), a);
  assert.equal(a.union(a), a);
});

test('value equality, hashing, sets of sets', () => {
  const a = PersistentSet.from(['x', 'y', 'z']);
  const b = PersistentSet.from(['z', 'y', 'x']);
  assert.ok(a.equals(b));
  assert.equal(a.hashCode(), b.hashCode());
  const outer = PersistentSet.of(a, PersistentSet.of('q'));
  assert.ok(outer.has(b));
  assert.equal(outer.add(b), outer);
  assert.ok(!a.equals(PersistentMap.from([['x', true], ['y', true], ['z', true]])));
});

test('set diff', () => {
  const a = PersistentSet.from(Array.from({ length: 1000 }, (_, i) => i));
  const b = a.delete(10).add(5000);
  const d = a.diff(b);
  assert.deepEqual(d.removed, [10]);
  assert.deepEqual(d.added, [5000]);
});
