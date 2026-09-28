// Small seeded PRNG (mulberry32) so randomised tests are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A value-object key with a deliberately terrible hash, to force collisions. */
export class BadKey {
  constructor(id, hash = 42) {
    this.id = id;
    this.h = hash;
  }
  hashCode() {
    return this.h;
  }
  equals(o) {
    return o instanceof BadKey && o.id === this.id;
  }
  toString() {
    return `BadKey(${this.id})`;
  }
}
