// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

interface RevisionState<C> {
  readonly data: C;
  revision: number;
  owners: number;
}

class RevisionCell<C> {
  private state: RevisionState<C>;
  private releasable: boolean;

  constructor(
    data: C,
    private readonly copy: (source: C) => C,
    releasable = false,
  ) {
    this.state = { data, revision: 0, owners: 1 };
    this.releasable = releasable;
  }

  get data(): C {
    return this.state.data;
  }

  get revision(): number {
    return this.state.revision;
  }

  share(): RevisionCell<C> {
    const shared = new RevisionCell(this.state.data, this.copy, true);
    shared.state = this.state;
    this.state.owners += 1;
    return shared;
  }

  release(): void {
    if (!this.releasable) return;
    this.releasable = false;
    this.state.owners -= 1;
  }

  mutate(change: (data: C) => void): void {
    if (this.state.owners > 1) {
      const shared = this.state;
      shared.owners -= 1;
      this.state = {
        data: this.copy(shared.data),
        revision: shared.revision,
        owners: 1,
      };
    }
    change(this.state.data);
    this.state.revision += 1;
  }
}

/** A Map with a monotone revision and constant-time copy-on-write snapshots. */
export class RevisionMap<K, V> extends Map<K, V> {
  private cell: RevisionCell<Map<K, V>>;

  constructor(entries?: Iterable<readonly [K, V]>) {
    super();
    this.cell = new RevisionCell(new Map(entries), (source) => new Map(source));
  }

  get revision(): number {
    return this.cell.revision;
  }

  override get size(): number {
    return this.cell.data.size;
  }

  /** Share the current map until either side changes it. */
  snapshot(): RevisionMap<K, V> {
    const snapshot = new RevisionMap<K, V>();
    snapshot.cell = this.cell.share();
    return snapshot;
  }

  /** Release an unused snapshot without copying its data. */
  releaseSnapshot(): void {
    this.cell.release();
  }

  override has(key: K): boolean {
    return this.cell.data.has(key);
  }

  override get(key: K): V | undefined {
    return this.cell.data.get(key);
  }

  override set(key: K, value: V): this {
    if (!this.has(key) || !Object.is(this.get(key), value)) {
      this.cell.mutate((data) => data.set(key, value));
    }
    return this;
  }

  override delete(key: K): boolean {
    if (!this.has(key)) return false;
    this.cell.mutate((data) => data.delete(key));
    return true;
  }

  override clear(): void {
    if (this.size === 0) return;
    this.cell.mutate((data) => data.clear());
  }

  override entries(): MapIterator<[K, V]> {
    return this.cell.data.entries();
  }

  override keys(): MapIterator<K> {
    return this.cell.data.keys();
  }

  override values(): MapIterator<V> {
    return this.cell.data.values();
  }

  override forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.cell.data.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.cell.data[Symbol.iterator]();
  }
}

/** A Set with a monotone revision and constant-time copy-on-write snapshots. */
export class RevisionSet<T> extends Set<T> {
  private cell: RevisionCell<Set<T>>;

  constructor(values?: Iterable<T>) {
    super();
    this.cell = new RevisionCell(new Set(values), (source) => new Set(source));
  }

  get revision(): number {
    return this.cell.revision;
  }

  override get size(): number {
    return this.cell.data.size;
  }

  /** Share the current set until either side changes it. */
  snapshot(): RevisionSet<T> {
    const snapshot = new RevisionSet<T>();
    snapshot.cell = this.cell.share();
    return snapshot;
  }

  /** Release an unused snapshot without copying its data. */
  releaseSnapshot(): void {
    this.cell.release();
  }

  override has(value: T): boolean {
    return this.cell.data.has(value);
  }

  override add(value: T): this {
    if (!this.has(value)) {
      this.cell.mutate((data) => data.add(value));
    }
    return this;
  }

  override delete(value: T): boolean {
    if (!this.has(value)) return false;
    this.cell.mutate((data) => data.delete(value));
    return true;
  }

  override clear(): void {
    if (this.size === 0) return;
    this.cell.mutate((data) => data.clear());
  }

  override entries(): SetIterator<[T, T]> {
    return this.cell.data.entries();
  }

  override keys(): SetIterator<T> {
    return this.cell.data.keys();
  }

  override values(): SetIterator<T> {
    return this.cell.data.values();
  }

  override forEach(
    callbackfn: (value: T, value2: T, set: Set<T>) => void,
    thisArg?: unknown,
  ): void {
    this.cell.data.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }

  override [Symbol.iterator](): SetIterator<T> {
    return this.cell.data[Symbol.iterator]();
  }
}

/** Return a collection revision when mutations are observable, otherwise undefined. */
export function collectionRevision(collection: object): number | undefined {
  const revision = (collection as { readonly revision?: unknown }).revision;
  return typeof revision === "number" ? revision : undefined;
}

/** Keep an existing revisioned map or copy an ordinary map into one. */
export function asRevisionMap<K, V>(source: ReadonlyMap<K, V>): RevisionMap<K, V> {
  return source instanceof RevisionMap ? source : new RevisionMap(source);
}
