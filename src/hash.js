// Hashing and equality protocol used by every collection in this package.
//
// Keys are compared with SameValueZero semantics (like the built-in Map), with one
// extension: any object that implements BOTH `hashCode()` and `equals(other)` is
// treated as a value object. PersistentMap and PersistentSet implement that
// protocol themselves, so collections can be used as keys of other collections.
//
// Contract for value objects: if a.equals(b) then a.hashCode() === b.hashCode().

/** Murmur3 finaliser: spreads entropy across all 32 bits. */
export function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over UTF-16 code units, then fmix32 for good avalanche in the low bits. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

const HASH_NULL = 0x6c8e9cf5;
const HASH_UNDEFINED = 0x1d4f3e5a;
const HASH_TRUE = 0x4f1bbcdd;
const HASH_FALSE = 0x2a9d8e17;

// Identity hashes for plain objects/functions. A WeakMap means the ids never keep
// a key alive. Symbols cannot always be WeakMap keys (registered symbols), so they
// get a regular Map; symbol keys are rare and this is documented in the README.
const objectIds = new WeakMap();
const symbolIds = new Map();
let nextId = 1;

function identityHash(x, table) {
  let id = table.get(x);
  if (id === undefined) {
    id = nextId++;
    table.set(x, id);
  }
  return fmix32(id);
}

export function isValueObject(x) {
  return (
    x !== null &&
    typeof x === 'object' &&
    typeof x.hashCode === 'function' &&
    typeof x.equals === 'function'
  );
}

/** 32-bit unsigned hash consistent with `equals`. */
export function hashOf(x) {
  switch (typeof x) {
    case 'string':
      return hashString(x);
    case 'number':
      // Integers in int32 range (including -0, which `x | 0` folds to 0) hash
      // directly; everything else, NaN included, goes through its string form.
      if ((x | 0) === x) return fmix32(x | 0);
      return hashString(String(x));
    case 'boolean':
      return x ? HASH_TRUE : HASH_FALSE;
    case 'undefined':
      return HASH_UNDEFINED;
    case 'bigint':
      return hashString('bigint:' + x.toString());
    case 'symbol':
      return identityHash(x, symbolIds);
    case 'object':
      if (x === null) return HASH_NULL;
      if (isValueObject(x)) return x.hashCode() >>> 0;
      return identityHash(x, objectIds);
    default: // function
      return identityHash(x, objectIds);
  }
}

/** SameValueZero, plus value object equality. */
export function equals(a, b) {
  if (a === b) return true;
  if (a !== a && b !== b) return true; // NaN
  if (isValueObject(a)) return a.equals(b);
  return false;
}
