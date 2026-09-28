import { PersistentMap } from './map.js';

/** An immutable hash set backed by a PersistentMap whose values are all `true`. */
export class PersistentSet {
  /** @internal */
  constructor(map) {
    this._map = map;
  }

  static empty() {
    return EMPTY_SET;
  }

  static from(iterable = []) {
    if (iterable instanceof PersistentSet) return iterable;
    return EMPTY_SET.withMutations((t) => {
      for (const x of iterable) t.add(x);
    });
  }

  static of(...items) {
    return PersistentSet.from(items);
  }

  _wrap(map) {
    if (map === this._map) return this;
    return map.size === 0 ? EMPTY_SET : new PersistentSet(map);
  }

  get size() {
    return this._map.size;
  }
  has(x) {
    return this._map.has(x);
  }
  add(x) {
    return this._wrap(this._map.set(x, true));
  }
  delete(x) {
    return this._wrap(this._map.delete(x));
  }

  union(other) {
    const o = PersistentSet.from(other);
    const [big, small] = this.size >= o.size ? [this, o] : [o, this];
    return big.withMutations((t) => {
      for (const x of small) t.add(x);
    });
  }

  intersection(other) {
    const o = PersistentSet.from(other);
    const [small, big] = this.size <= o.size ? [this, o] : [o, this];
    return small.withMutations((t) => {
      for (const x of small) if (!big.has(x)) t.delete(x);
    });
  }

  difference(other) {
    const o = PersistentSet.from(other);
    return this.withMutations((t) => {
      for (const x of o) t.delete(x);
    });
  }

  isSubsetOf(other) {
    const o = PersistentSet.from(other);
    if (this.size > o.size) return false;
    for (const x of this) if (!o.has(x)) return false;
    return true;
  }

  filter(pred) {
    return this.withMutations((t) => {
      for (const x of this) if (!pred(x, this)) t.delete(x);
    });
  }

  *[Symbol.iterator]() {
    yield* this._map.keys();
  }
  values() {
    return this[Symbol.iterator]();
  }
  forEach(fn) {
    this._map.forEach((_, k) => fn(k, this));
  }
  toArray() {
    return [...this];
  }
  toJSON() {
    return this.toArray();
  }
  toString() {
    return `PersistentSet(${this.size}) { ${this.toArray().map(String).join(', ')} }`;
  }

  equals(other) {
    return other instanceof PersistentSet && this._map.equals(other._map);
  }
  hashCode() {
    return this._map.hashCode() ^ 0x5bd1e995;
  }

  /** { added: [x], removed: [x] } going from this set to `other`. */
  diff(other) {
    const d = this._map.diff(PersistentSet.from(other)._map);
    return { added: d.added.map(([k]) => k), removed: d.removed.map(([k]) => k), visited: d.visited };
  }

  withMutations(fn) {
    const t = this._map.asMutable();
    const view = {
      add: (x) => (t.set(x, true), view),
      delete: (x) => (t.delete(x), view),
      has: (x) => t.has(x),
      get size() {
        return t.size;
      },
    };
    fn(view);
    return this._wrap(t.persistent());
  }

  stats() {
    return this._map.stats();
  }
}

const EMPTY_SET = new PersistentSet(PersistentMap.empty());
