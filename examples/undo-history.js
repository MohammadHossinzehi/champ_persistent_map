// A tiny document store with unlimited undo, built on persistent maps.
// Each edit produces a new version; old versions cost almost nothing to keep
// because they share structure, and `diff` tells us exactly what an undo reverts.
import { PersistentMap } from '../src/index.js';

class History {
  constructor(initial = PersistentMap.empty()) {
    this.versions = [initial];
    this.cursor = 0;
  }
  get current() {
    return this.versions[this.cursor];
  }
  apply(label, fn) {
    const next = fn(this.current);
    if (next === this.current) return console.log(`(${label}: no change)`);
    this.versions = this.versions.slice(0, this.cursor + 1);
    this.versions.push(next);
    this.cursor++;
    console.log(`${label}:`, describe(this.versions[this.cursor - 1].diff(next)));
  }
  undo() {
    if (this.cursor === 0) return;
    const d = this.current.diff(this.versions[this.cursor - 1]);
    this.cursor--;
    console.log('undo:', describe(d));
  }
  redo() {
    if (this.cursor === this.versions.length - 1) return;
    const d = this.current.diff(this.versions[this.cursor + 1]);
    this.cursor++;
    console.log('redo:', describe(d));
  }
}

function describe({ added, removed, changed }) {
  return [
    ...added.map(([k, v]) => `+${k}=${JSON.stringify(v)}`),
    ...removed.map(([k]) => `-${k}`),
    ...changed.map(([k, a, b]) => `${k}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`),
  ].join(', ');
}

const h = new History();
h.apply('create', (doc) => doc.merge({ title: 'Draft', body: 'Hello', tags: 'misc' }));
h.apply('rename', (doc) => doc.set('title', 'Final'));
h.apply('retag', (doc) => doc.delete('tags').set('status', 'review'));
h.apply('noop', (doc) => doc.set('title', 'Final'));
h.undo();
h.undo();
h.redo();
console.log('current:', h.current.toObject());
console.log('versions kept:', h.versions.length);
