// CHAMP: Compressed Hash-Array Mapped Prefix-tree.
//
// Steindorfer & Vinju, "Optimizing Hash-Array Mapped Tries for Fast and Lean
// Immutable JVM Collections" (OOPSLA 2015). Compared with a classic HAMT (Bagwell)
// each node keeps two bitmaps instead of one:
//
//   dataMap  bit i set -> fragment i holds an inline key/value pair
//   nodeMap  bit i set -> fragment i holds a child node
//
// Inline entries and children live in separate dense arrays, so iteration never has
// to type-test slots, and deletion restores a *canonical* shape: a sub-trie that
// shrinks to a single entry is always inlined into its parent. Two maps with the
// same contents therefore have the same tree shape regardless of insertion order,
// which is what makes structural equality and structural diff cheap.
//
// Every mutating method takes an `owner` token. `null` means "persistent: copy on
// write". A non-null token lets a transient edit nodes it created in place.

import { hashOf, equals } from './hash.js';

export const BITS = 5;
export const MASK = (1 << BITS) - 1; // 31
// Hashes are 32 bits: shifts 0,5,...,30 consume them (the last level sees 2 bits).
// Keys whose hashes are fully equal end up in a CollisionNode below that.
export const MAX_SHIFT = 30;

export const NOT_FOUND = Symbol('champ.notFound');

export function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

export const fragment = (hash, shift) => (hash >>> shift) & MASK;
export const bitpos = (hash, shift) => 1 << ((hash >>> shift) & MASK);
/** Dense array index of `bit` within `bitmap`: number of set bits below it. */
export const index = (bitmap, bit) => popcount(bitmap & (bit - 1));

export class BitmapNode {
  constructor(owner, dataMap, nodeMap, data, nodes) {
    this.owner = owner;
    this.dataMap = dataMap;
    this.nodeMap = nodeMap;
    this.data = data; // [k0, v0, k1, v1, ...] ordered by fragment
    this.nodes = nodes; // [child0, child1, ...] ordered by fragment
  }

  /** Return a node we are allowed to mutate: ourselves if owned, else a copy. */
  editable(owner) {
    if (owner !== null && owner === this.owner) return this;
    return new BitmapNode(owner, this.dataMap, this.nodeMap, this.data.slice(), this.nodes.slice());
  }

  get(key, hash, shift, notFound) {
    const bit = bitpos(hash, shift);
    if (this.dataMap & bit) {
      const i = 2 * index(this.dataMap, bit);
      return equals(this.data[i], key) ? this.data[i + 1] : notFound;
    }
    if (this.nodeMap & bit) {
      return this.nodes[index(this.nodeMap, bit)].get(key, hash, shift + BITS, notFound);
    }
    return notFound;
  }

  set(owner, key, value, hash, shift, change) {
    const bit = bitpos(hash, shift);

    if (this.dataMap & bit) {
      const i = 2 * index(this.dataMap, bit);
      const k = this.data[i];
      if (equals(k, key)) {
        if (Object.is(this.data[i + 1], value)) return this;
        const n = this.editable(owner);
        n.data[i + 1] = value;
        change.replaced = true;
        return n;
      }
      // Two different keys share this fragment: push both one level down.
      const sub = mergeTwo(owner, k, this.data[i + 1], hashOf(k), key, value, hash, shift + BITS);
      const n = this.editable(owner);
      n.data.splice(i, 2);
      n.dataMap ^= bit;
      n.nodes.splice(index(n.nodeMap, bit), 0, sub);
      n.nodeMap |= bit;
      change.added = true;
      return n;
    }

    if (this.nodeMap & bit) {
      const j = index(this.nodeMap, bit);
      const sub = this.nodes[j];
      const updated = sub.set(owner, key, value, hash, shift + BITS, change);
      if (updated === sub) return this; // unchanged, or edited in place by a transient
      const n = this.editable(owner);
      n.nodes[j] = updated;
      return n;
    }

    const i = 2 * index(this.dataMap, bit);
    const n = this.editable(owner);
    n.data.splice(i, 0, key, value);
    n.dataMap |= bit;
    change.added = true;
    return n;
  }

  delete(owner, key, hash, shift, change) {
    const bit = bitpos(hash, shift);

    if (this.dataMap & bit) {
      const i = 2 * index(this.dataMap, bit);
      if (!equals(this.data[i], key)) return this;
      const n = this.editable(owner);
      n.data.splice(i, 2);
      n.dataMap ^= bit;
      change.removed = true;
      return n;
    }

    if (this.nodeMap & bit) {
      const j = index(this.nodeMap, bit);
      const sub = this.nodes[j];
      const updated = sub.delete(owner, key, hash, shift + BITS, change);
      if (!change.removed) return this;
      if (updated.isSingleton()) {
        // Canonical form: a child holding exactly one entry is inlined here.
        const n = this.editable(owner);
        n.nodes.splice(j, 1);
        n.nodeMap ^= bit;
        n.data.splice(2 * index(n.dataMap, bit), 0, updated.singleKey(), updated.singleValue());
        n.dataMap |= bit;
        return n;
      }
      if (updated === sub) return this;
      const n = this.editable(owner);
      n.nodes[j] = updated;
      return n;
    }

    return this;
  }

  isSingleton() {
    return this.nodeMap === 0 && this.data.length === 2;
  }
  singleKey() {
    return this.data[0];
  }
  singleValue() {
    return this.data[1];
  }

  forEach(fn) {
    const d = this.data;
    for (let i = 0; i < d.length; i += 2) fn(d[i + 1], d[i]);
    for (let j = 0; j < this.nodes.length; j++) this.nodes[j].forEach(fn);
  }

  *entries() {
    const d = this.data;
    for (let i = 0; i < d.length; i += 2) yield [d[i], d[i + 1]];
    for (let j = 0; j < this.nodes.length; j++) yield* this.nodes[j].entries();
  }
}

/** Bucket for keys whose 32-bit hashes are identical. Linear scan; order is insertion. */
export class CollisionNode {
  constructor(owner, hash, data) {
    this.owner = owner;
    this.hash = hash;
    this.data = data;
  }

  editable(owner) {
    if (owner !== null && owner === this.owner) return this;
    return new CollisionNode(owner, this.hash, this.data.slice());
  }

  find(key) {
    const d = this.data;
    for (let i = 0; i < d.length; i += 2) if (equals(d[i], key)) return i;
    return -1;
  }

  get(key, _hash, _shift, notFound) {
    const i = this.find(key);
    return i < 0 ? notFound : this.data[i + 1];
  }

  set(owner, key, value, _hash, _shift, change) {
    const i = this.find(key);
    if (i >= 0) {
      if (Object.is(this.data[i + 1], value)) return this;
      const n = this.editable(owner);
      n.data[i + 1] = value;
      change.replaced = true;
      return n;
    }
    const n = this.editable(owner);
    n.data.push(key, value);
    change.added = true;
    return n;
  }

  delete(owner, key, _hash, _shift, change) {
    const i = this.find(key);
    if (i < 0) return this;
    const n = this.editable(owner);
    n.data.splice(i, 2);
    change.removed = true;
    return n;
  }

  isSingleton() {
    return this.data.length === 2;
  }
  singleKey() {
    return this.data[0];
  }
  singleValue() {
    return this.data[1];
  }

  forEach(fn) {
    const d = this.data;
    for (let i = 0; i < d.length; i += 2) fn(d[i + 1], d[i]);
  }

  *entries() {
    const d = this.data;
    for (let i = 0; i < d.length; i += 2) yield [d[i], d[i + 1]];
  }
}

/** Build the smallest sub-trie holding two distinct keys. */
function mergeTwo(owner, k1, v1, h1, k2, v2, h2, shift) {
  if (shift > MAX_SHIFT) return new CollisionNode(owner, h1, [k1, v1, k2, v2]);
  const f1 = fragment(h1, shift);
  const f2 = fragment(h2, shift);
  if (f1 !== f2) {
    const data = f1 < f2 ? [k1, v1, k2, v2] : [k2, v2, k1, v1];
    return new BitmapNode(owner, (1 << f1) | (1 << f2), 0, data, []);
  }
  return new BitmapNode(owner, 0, 1 << f1, [], [mergeTwo(owner, k1, v1, h1, k2, v2, h2, shift + BITS)]);
}

export const EMPTY_NODE = new BitmapNode(null, 0, 0, [], []);

/**
 * Structural equality. Thanks to canonical form, equal maps have identical bitmaps
 * at every level, so we can compare node by node and skip shared subtrees by
 * reference. Only collision buckets need an order-insensitive comparison.
 */
export function nodeEquals(a, b) {
  if (a === b) return true;
  if (a instanceof CollisionNode || b instanceof CollisionNode) {
    if (!(a instanceof CollisionNode && b instanceof CollisionNode)) return false;
    if (a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i += 2) {
      const v = b.get(a.data[i], 0, 0, NOT_FOUND);
      if (v === NOT_FOUND || !equals(a.data[i + 1], v)) return false;
    }
    return true;
  }
  if (a.dataMap !== b.dataMap || a.nodeMap !== b.nodeMap) return false;
  for (let i = 0; i < a.data.length; i++) if (!equals(a.data[i], b.data[i])) return false;
  for (let j = 0; j < a.nodes.length; j++) if (!nodeEquals(a.nodes[j], b.nodes[j])) return false;
  return true;
}

function pushAll(node, list) {
  node.forEach((v, k) => list.push([k, v]));
}

/**
 * Structural diff between two tries at the same depth. Subtrees shared by
 * reference are skipped entirely, so diffing a large map against a version with a
 * handful of edits costs O(edits * depth), not O(n).
 * `out.visited` counts nodes actually inspected (handy for tests and benchmarks).
 */
export function diffNodes(a, b, shift, out) {
  if (a === b) return;
  out.visited++;
  if (a instanceof CollisionNode || b instanceof CollisionNode) {
    diffGeneric(a, b, out);
    return;
  }
  let all = a.dataMap | a.nodeMap | b.dataMap | b.nodeMap;
  while (all !== 0) {
    const bit = all & -all; // lowest set bit
    all ^= bit;
    const inAData = a.dataMap & bit, inANode = a.nodeMap & bit;
    const inBData = b.dataMap & bit, inBNode = b.nodeMap & bit;

    if (inAData && inBData) {
      const i = 2 * index(a.dataMap, bit), j = 2 * index(b.dataMap, bit);
      const ka = a.data[i], va = a.data[i + 1], kb = b.data[j], vb = b.data[j + 1];
      if (equals(ka, kb)) {
        if (!equals(va, vb)) out.changed.push([ka, va, vb]);
      } else {
        out.removed.push([ka, va]);
        out.added.push([kb, vb]);
      }
    } else if (inANode && inBNode) {
      diffNodes(a.nodes[index(a.nodeMap, bit)], b.nodes[index(b.nodeMap, bit)], shift + BITS, out);
    } else if (inAData && inBNode) {
      const i = 2 * index(a.dataMap, bit);
      diffEntryAgainstNode(a.data[i], a.data[i + 1], b.nodes[index(b.nodeMap, bit)], shift + BITS, out, false);
    } else if (inANode && inBData) {
      const j = 2 * index(b.dataMap, bit);
      diffEntryAgainstNode(b.data[j], b.data[j + 1], a.nodes[index(a.nodeMap, bit)], shift + BITS, out, true);
    } else if (inAData) {
      const i = 2 * index(a.dataMap, bit);
      out.removed.push([a.data[i], a.data[i + 1]]);
    } else if (inANode) {
      pushAll(a.nodes[index(a.nodeMap, bit)], out.removed);
    } else if (inBData) {
      const j = 2 * index(b.dataMap, bit);
      out.added.push([b.data[j], b.data[j + 1]]);
    } else {
      pushAll(b.nodes[index(b.nodeMap, bit)], out.added);
    }
  }
}

// One side has a single inline entry (k, v), the other a whole sub-trie.
// `reversed` = the inline entry belongs to the *new* map.
function diffEntryAgainstNode(k, v, node, shift, out, reversed) {
  const other = node.get(k, hashOf(k), shift, NOT_FOUND);
  if (other === NOT_FOUND) (reversed ? out.added : out.removed).push([k, v]);
  else if (!equals(v, other)) out.changed.push(reversed ? [k, other, v] : [k, v, other]);
  node.forEach((val, key) => {
    if (!equals(key, k)) (reversed ? out.removed : out.added).push([key, val]);
  });
}

function diffGeneric(a, b, out) {
  a.forEach((va, k) => {
    const vb = b.get(k, hashOf(k), MAX_SHIFT + BITS, NOT_FOUND);
    if (vb === NOT_FOUND) out.removed.push([k, va]);
    else if (!equals(va, vb)) out.changed.push([k, va, vb]);
  });
  b.forEach((vb, k) => {
    if (a.get(k, hashOf(k), MAX_SHIFT + BITS, NOT_FOUND) === NOT_FOUND) out.added.push([k, vb]);
  });
}

/** Shape statistics: node counts, depth, and where entries live. */
export function collectStats(root) {
  const s = { bitmapNodes: 0, collisionNodes: 0, maxDepth: 0, entriesByDepth: [] };
  (function walk(node, depth) {
    if (depth > s.maxDepth) s.maxDepth = depth;
    if (node instanceof CollisionNode) s.collisionNodes++;
    else s.bitmapNodes++;
    s.entriesByDepth[depth] = (s.entriesByDepth[depth] || 0) + node.data.length / 2;
    if (node instanceof BitmapNode) for (const c of node.nodes) walk(c, depth + 1);
  })(root, 0);
  for (let i = 0; i < s.entriesByDepth.length; i++) s.entriesByDepth[i] = s.entriesByDepth[i] || 0;
  return s;
}

/** Visit every node object reachable from `root`. */
export function walkNodes(root, fn) {
  fn(root);
  if (root instanceof BitmapNode) for (const c of root.nodes) walkNodes(c, fn);
}
