import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentMap } from '../src/index.js';
import { BadKey } from './helpers.js';

test('transient edits never leak into the source map', () => {
  const base = PersistentMap.from(Array.from({ length: 2000 }, (_, i) => [i, i]));
  const snapshot = [...base];
  const t = base.asMutable();
  for (let i = 0; i < 2000; i += 2) t.delete(i);
  for (let i = 0; i < 500; i++) t.set(i, 'x');
  const result = t.persistent();
  assert.equal(base.size, 2000);
  assert.deepEqual([...base], snapshot);
  assert.equal(result.get(1), 'x');
  assert.equal(result.get(2), 'x');
  assert.equal(result.has(1000), false);
  assert.equal(result.size, 1000 + 250);
});

test('transient is sealed after persistent()', () => {
  const t = PersistentMap.empty().asMutable();
  t.set('a', 1);
  const m = t.persistent();
  assert.throws(() => t.set('b', 2), /after persistent/);
  assert.throws(() => t.get('a'), /after persistent/);
  assert.equal(m.size, 1);
});

test('persistent edits after a transient do not mutate the transient result', () => {
  const m = PersistentMap.empty().withMutations((t) => {
    for (let i = 0; i < 1000; i++) t.set(i, i);
  });
  const m2 = m.set(5, 'five');
  assert.equal(m.get(5), 5);
  assert.equal(m2.get(5), 'five');
});

test('two transients from the same map are independent', () => {
  const base = PersistentMap.from(Array.from({ length: 300 }, (_, i) => [i, i]));
  const a = base.asMutable();
  const b = base.asMutable();
  a.set(1, 'a');
  b.set(1, 'b');
  a.delete(2);
  assert.equal(a.persistent().get(1), 'a');
  const bm = b.persistent();
  assert.equal(bm.get(1), 'b');
  assert.equal(bm.get(2), 2);
});

test('transient with collisions and size tracking', () => {
  const m = PersistentMap.empty().withMutations((t) => {
    for (let i = 0; i < 10; i++) t.set(new BadKey(i), i);
    t.set(new BadKey(3), 'three');
    t.delete(new BadKey(4));
    t.delete(new BadKey(404));
    assert.equal(t.size, 9);
  });
  assert.equal(m.size, 9);
  assert.equal(m.get(new BadKey(3)), 'three');
});

test('withMutations result equals the persistent build', () => {
  const entries = Array.from({ length: 3000 }, (_, i) => ['k' + i, i]);
  let slow = PersistentMap.empty();
  for (const [k, v] of entries) slow = slow.set(k, v);
  const fast = PersistentMap.from(entries);
  assert.ok(slow.equals(fast));
  assert.deepEqual(slow.stats(), fast.stats());
});
