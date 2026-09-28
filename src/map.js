import { hashOf, equals, fmix32 } from './hash.js';
import { EMPTY_NODE, NOT_FOUND, nodeEquals, diffNodes, collectStats, walkNodes } from './node.js';

const newChange = () => ({ added: false, replaced: false, removed: false });

function entriesOf(source) {
  if (source == null) return [];
  if (typeof source[Symbol.iterator] === 'function') return source;
  if (typeof source === 'object') return Object.entries(source);
  throw new TypeError('expected an iterable of [key, value] pairs or a plain object');
}

/**
 * An immutable hash map. Every "modifying" method returns a new map that shares
 * all untouched structure with the old one; the old map is never changed.
 * Operations that change nothing return `this`, so `a === b` is a valid (and
 * very cheap) "definitely unchanged" check.
 */
export class PersistentMap {
  /** @internal use PersistentMap.empty() / PersistentMap.from() */
  constructor(root, size) {
    this._root = root;
    this._size = size;
    this._hash = undefined;
  }

  static empty() {
    return EMPTY_MAP;
  }

  /** Build from a Map, a PersistentMap, any iterable of [k, v], or a plain object. */
  static from(source) {
    if (source instanceof PersistentMap) return source;
    return EMPTY_MAP.withMutations((t) => {
      for (const [k, v] of entriesOf(source)) t.set(k, v);
    });
  }

  static isMap(x) {
    return x instanceof PersistentMap;
  }

  get size() {
    return this._size;
  }

  get(key, notFound = undefined) {
    const v = this._root.get(key, hashOf(key), 0, NOT_FOUND);
    return v === NOT_FOUND ? notFound : v;
  }

  has(key) {
    return this._root.get(key, hashOf(key), 0, NOT_FOUND) !== NOT_FOUND;
  }

  set(key, value) {
    const change = newChange();
    const root = this._root.set(null, key, value, hashOf(key), 0, change);
    if (root === this._root) return this;
    return new PersistentMap(root, this._size + (change.added ? 1 : 0));
  }

  delete(key) {
    const change = newChange();
    const root = this._root.delete(null, key, hashOf(key), 0, change);
    if (!change.removed) return this;
    return this._size === 1 ? EMPTY_MAP : new PersistentMap(root, this._size - 1);
  }

  /** set(key, fn(currentValue ?? notSetValue)) */
  update(key, fn, notSetValue = undefined) {
    return this.set(key, fn(this.get(key, notSetValue)));
  }

  /** Right-most source wins. Accepts the same inputs as `from`. */
  merge(...sources) {
    return this.withMutations((t) => {
      for (const s of sources) for (const [k, v] of entriesOf(s)) t.set(k, v);
    });
  }

  filter(pred) {
    return this.withMutations((t) => {
      this._root.forEach((v, k) => {
        if (!pred(v, k, this)) t.delete(k);
      });
    });
  }

  mapValues(fn) {
    return this.withMutations((t) => {
      this._root.forEach((v, k) => t.set(k, fn(v, k, this)));
    });
  }

  forEach(fn) {
    this._root.forEach((v, k) => fn(v, k, this));
  }

  entries() {
    return this._root.entries();
  }
  [Symbol.iterator]() {
    return this._root.entries();
  }
  *keys() {
    for (const [k] of this._root.entries()) yield k;
  }
  *values() {
    for (const [, v] of this._root.entries()) yield v;
  }

  toObject() {
    const o = {};
    this._root.forEach((v, k) => (o[String(k)] = v));
    return o;
  }
  toJSON() {
    return this.toObject();
  }
  toString() {
    const parts = [];
    this._root.forEach((v, k) => parts.push(`${String(k)} => ${String(v)}`));
    return `PersistentMap(${this._size}) { ${parts.join(', ')} }`;
  }

  /** Value equality. O(1) for shared roots; O(size) worst case otherwise. */
  equals(other) {
    if (this === other) return true;
    if (!(other instanceof PersistentMap) || other._size !== this._size) return false;
    if (this._hash !== undefined && other._hash !== undefined && this._hash !== other._hash) return false;
    return nodeEquals(this._root, other._root);
  }

  /** Order-independent, cached. Equal maps always have equal hash codes. */
  hashCode() {
    if (this._hash === undefined) {
      let h = 0;
      this._root.forEach((v, k) => {
        h = (h + (hashOf(k) ^ Math.imul(hashOf(v), 0x9e3779b1))) | 0;
      });
      this._hash = fmix32(h ^ this._size);
    }
    return this._hash;
  }

  /**
   * What changed going from `this` to `other`?
   * Returns { added: [[k, v]], removed: [[k, v]], changed: [[k, before, after]], visited }.
   * Shared subtrees are skipped by reference, so this is proportional to the size
   * of the difference, not the size of the maps.
   */
  diff(other) {
    const out = { added: [], removed: [], changed: [], visited: 0 };
    diffNodes(this._root, PersistentMap.from(other)._root, 0, out);
    return out;
  }

  asMutable() {
    return new TransientMap(this);
  }

  /** Batch many edits with in-place node mutation, then freeze again. */
  withMutations(fn) {
    const t = this.asMutable();
    fn(t);
    return t.persistent();
  }

  /** Tree shape information (node counts, depth, entries per level). */
  stats() {
    return { size: this._size, ...collectStats(this._root) };
  }

  /** How many node objects of `other` are physically shared with this map. */
  sharedNodeCount(other) {
    const mine = new Set();
    walkNodes(this._root, (n) => mine.add(n));
    let shared = 0, total = 0;
    walkNodes(other._root, (n) => {
      total++;
      if (mine.has(n)) shared++;
    });
    return { shared, total };
  }
}

const EMPTY_MAP = new PersistentMap(EMPTY_NODE, 0);

/**
 * A short-lived mutable view. Nodes it creates are stamped with a private owner
 * token and are edited in place; nodes shared with the source map are copied on
 * first write, so the source map is never affected. After `persistent()` the
 * token is discarded and the transient refuses further use.
 */
export class TransientMap {
  constructor(map) {
    this._owner = {};
    this._root = map._root;
    this._size = map._size;
    this._origin = map;
  }

  _check() {
    if (this._owner === null) throw new Error('TransientMap used after persistent()');
  }

  get size() {
    this._check();
    return this._size;
  }

  get(key, notFound = undefined) {
    this._check();
    const v = this._root.get(key, hashOf(key), 0, NOT_FOUND);
    return v === NOT_FOUND ? notFound : v;
  }

  has(key) {
    this._check();
    return this._root.get(key, hashOf(key), 0, NOT_FOUND) !== NOT_FOUND;
  }

  set(key, value) {
    this._check();
    const change = newChange();
    this._root = this._root.set(this._owner, key, value, hashOf(key), 0, change);
    if (change.added) this._size++;
    return this;
  }

  delete(key) {
    this._check();
    const change = newChange();
    this._root = this._root.delete(this._owner, key, hashOf(key), 0, change);
    if (change.removed) this._size--;
    return this;
  }

  update(key, fn, notSetValue = undefined) {
    return this.set(key, fn(this.get(key, notSetValue)));
  }

  persistent() {
    this._check();
    this._owner = null;
    if (this._root === this._origin._root) return this._origin;
    if (this._size === 0) return EMPTY_MAP;
    return new PersistentMap(this._root, this._size);
  }
}

export { equals, hashOf };
