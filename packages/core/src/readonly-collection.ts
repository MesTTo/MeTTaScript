// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/** Copy a map behind an object that exposes no mutating methods. */
export function readonlyMapSnapshot<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const snapshot = new Map(source);
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size(): number {
      return snapshot.size;
    },
    has: (key: K): boolean => snapshot.has(key),
    get: (key: K): V | undefined => snapshot.get(key),
    entries: (): MapIterator<[K, V]> => snapshot.entries(),
    keys: (): MapIterator<K> => snapshot.keys(),
    values: (): MapIterator<V> => snapshot.values(),
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: (): MapIterator<[K, V]> => snapshot[Symbol.iterator](),
  });
  return view;
}

/** Copy a set behind an object that exposes no mutating methods. */
export function readonlySetSnapshot<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  const snapshot = new Set(source);
  const view: ReadonlySet<T> = Object.freeze({
    get size(): number {
      return snapshot.size;
    },
    has: (value: T): boolean => snapshot.has(value),
    entries: (): SetIterator<[T, T]> => snapshot.entries(),
    keys: (): SetIterator<T> => snapshot.keys(),
    values: (): SetIterator<T> => snapshot.values(),
    forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
      snapshot.forEach((value) => callback.call(thisArg, value, value, view));
    },
    [Symbol.iterator]: (): SetIterator<T> => snapshot[Symbol.iterator](),
  });
  return view;
}
