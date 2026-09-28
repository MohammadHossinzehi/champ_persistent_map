import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentMap } from '../src/index.js';
import { rng, shuffle, BadKey } from './helpers.js';

test('basic get / set / has / delete', () => {
  const m0 = PersistentMap.empty();
  const m1 = m0.set('a', 1).set('b', 2);
  assert.equal(m1.size, 2);
  assert.equal(m1.get('a'), 1);
  assert.equal(m1.get('missing'), undefined);
  assert.equal(m1.get('missing', 'dflt'), 'dflt');
  assert.ok(m1.has('b'));
  const m2 = m1.delete('a');
  assert.equal(m2.size, 1);
  assert.ok(!m2.has('a'));
  assert.equal(m1.get('a'), 1, 'older version is untouched');
  assert.equal(m0.size, 0);
});

test('no-op edits return the same instance', () => {
  const m = PersistentMap.from({ a: 1, b: 2 });
  assert.equal(m.set('a', 1), m);
  assert.equal(m.delete('zzz'), m);
  assert.equal(m.withMutations(() => {}), m);
  assert.equal(m.merge([]), m);
  assert.equal(m.delete('a').delete('b'), PersistentMap.empty());
});

test('keys follow SameValueZero: NaN, -0 and 0', () => {
  const m = PersistentMap.empty().set(NaN, 'nan').set(0, 'zero');
  assert.equal(m.get(NaN), 'nan');
  assert.equal(m.get(-0), 'zero');
  assert.equal(m.set(-0, 'zero'), m);
  assert.equal(m.size, 2);
});

test('distinguishes types and object identity', () => {
  const o1 = {}, o2 = {};
  const m = PersistentMap.from([[1, 'num'], ['1', 'str'], [1n, 'big'], [true, 't'], [null, 'n'], [undefined, 'u'], [o1, 'o1']]);
  assert.equal(m.size, 7);
  assert.equal(m.get(1), 'num');
  assert.equal(m.get('1'), 'str');
  assert.equal(m.get(1n), 'big');
  assert.equal(m.get(null), 'n');
  assert.equal(m.get(undefined), 'u');
  assert.ok(m.has(undefined));
  assert.equal(m.get(o1), 'o1');
  assert.equal(m.get(o2), undefined);
});

test('randomised operations agree with the built-in Map (20k ops)', () => {
  const rand = rng(1234);
  const ref = new Map();
  let m = PersistentMap.empty();
  const versions = [];
  for (let step = 0; step < 20000; step++) {
    const k = Math.floor(rand() * 3000);
    const key = rand() < 0.5 ? k : 'k' + k;
    const r = rand();
    if (r < 0.6) {
      const v = Math.floor(rand() * 100);
      ref.set(key, v);
      m = m.set(key, v);
    } else {
      ref.delete(key);
      m = m.delete(key);
    }
    assert.equal(m.size, ref.size);
    if (step % 2000 === 0) versions.push([m, new Map(ref)]);
  }
  for (const [k, v] of ref) assert.equal(m.get(k), v);
  assert.equal([...m].length, ref.size);
  // Every snapshot still reflects exactly the state at the time it was taken.
  for (const [snap, snapRef] of versions) {
    assert.equal(snap.size, snapRef.size);
    for (const [k, v] of snapRef) assert.equal(snap.get(k), v);
  }
});

test('canonical form: insertion order and deletion history do not affect shape', () => {
  const rand = rng(99);
  const keys = Array.from({ length: 5000 }, (_, i) => 'key-' + i);
  const a = PersistentMap.from(keys.map((k) => [k, k.length]));
  const b = PersistentMap.from(shuffle(keys, rand).map((k) => [k, k.length]));
  // Build c with lots of extra keys, then delete them again.
  let c = PersistentMap.from(shuffle(keys, rand).map((k) => [k, k.length]));
  const extra = Array.from({ length: 5000 }, (_, i) => 'extra-' + i);
  c = c.merge(extra.map((k) => [k, 0]));
  for (const k of shuffle(extra, rand)) c = c.delete(k);
  for (const m of [b, c]) {
    assert.ok(a.equals(m));
    assert.deepEqual(m.stats(), a.stats());
    assert.equal(m.hashCode(), a.hashCode());
  }
});

test('full hash collisions are handled and collapse back on delete', () => {
  const keys = Array.from({ length: 40 }, (_, i) => new BadKey(i));
  let m = PersistentMap.empty();
  for (const k of keys) m = m.set(k, k.id * 10);
  assert.equal(m.size, 40);
  assert.equal(m.stats().collisionNodes, 1);
  for (const k of keys) assert.equal(m.get(new BadKey(k.id)), k.id * 10);
  assert.equal(m.get(new BadKey(999)), undefined);
  for (let i = 0; i < 39; i++) m = m.delete(new BadKey(i));
  assert.equal(m.size, 1);
  const s = m.stats();
  assert.equal(s.collisionNodes, 0, 'singleton bucket is inlined back into the root');
  assert.equal(s.bitmapNodes, 1);
  assert.equal(m.get(new BadKey(39)), 390);
});

test('partial collisions: hashes sharing low bits go deep but stay correct', () => {
  // Same lowest 25 bits -> first five levels collide, they diverge at level 6.
  const keys = Array.from({ length: 64 }, (_, i) => new BadKey(i, (i << 25) | 0x1abcdef));
  const m = PersistentMap.from(keys.map((k) => [k, k.id]));
  assert.equal(m.size, 64);
  assert.ok(m.stats().maxDepth >= 5);
  for (const k of keys) assert.equal(m.get(k), k.id);
  let n = m;
  for (const k of keys.slice(1)) n = n.delete(k);
  assert.equal(n.stats().maxDepth, 0);
});

test('collections work as value keys', () => {
  const k1 = PersistentMap.from({ x: 1, y: 2 });
  const k2 = PersistentMap.from({ y: 2, x: 1 });
  const m = PersistentMap.empty().set(k1, 'point');
  assert.equal(m.get(k2), 'point');
  assert.equal(k1.hashCode(), k2.hashCode());
  assert.ok(!k1.equals(k1.set('x', 3)));
});

test('structural sharing: one update copies only the path to the leaf', () => {
  const m = PersistentMap.from(Array.from({ length: 50000 }, (_, i) => [i, i]));
  const m2 = m.set(12345, -1);
  const { shared, total } = m.sharedNodeCount(m2);
  assert.ok(total - shared <= m.stats().maxDepth + 1, `copied ${total - shared} nodes`);
});

test('update, merge, filter, mapValues, iteration helpers', () => {
  const m = PersistentMap.from({ a: 1, b: 2, c: 3 });
  assert.equal(m.update('a', (v) => v + 10).get('a'), 11);
  assert.equal(m.update('z', (v) => v + 1, 0).get('z'), 1);
  assert.deepEqual(m.merge({ c: 30, d: 4 }).toObject(), { a: 1, b: 2, c: 30, d: 4 });
  assert.deepEqual(m.filter((v) => v % 2 === 1).toObject(), { a: 1, c: 3 });
  assert.deepEqual(m.mapValues((v) => v * 2).toObject(), { a: 2, b: 4, c: 6 });
  assert.deepEqual([...m.keys()].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...m.values()].sort(), [1, 2, 3]);
  let sum = 0;
  m.forEach((v) => (sum += v));
  assert.equal(sum, 6);
  assert.equal(JSON.stringify(PersistentMap.from({ a: 1 })), '{"a":1}');
});
