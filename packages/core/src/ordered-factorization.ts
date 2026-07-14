// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/** A structural position in clause-major, left-to-right depth-first search. */
export interface DerivationOrder {
  readonly choice: number;
  readonly children: readonly DerivationOrder[];
  /** Stable source occurrence. Distinct duplicate derivations must never compare equal. */
  readonly occurrence: number;
}

export interface OrderedDerivation<T> {
  /** Source-order alternative selected at this call. Duplicate alternatives keep separate objects. */
  readonly choice: number;
  /** Source occurrence among derivations of the same completed call. */
  readonly occurrence: number;
  /** Logical child answers. Their derivation products are expanded left-to-right. */
  readonly children: readonly OrderedAnswer<T>[];
  /** Rebuild the deferred output from one value selected from each child. */
  readonly build: (children: readonly T[]) => T;
}

/** All packed derivations of one logical answer. */
export interface OrderedAnswer<T> {
  readonly derivations: readonly OrderedDerivation<T>[];
}

export interface OrderedValue<T> {
  readonly order: DerivationOrder;
  readonly value: T;
}

export function compareDerivationOrder(left: DerivationOrder, right: DerivationOrder): number {
  if (left.choice !== right.choice) return left.choice < right.choice ? -1 : 1;
  const common = Math.min(left.children.length, right.children.length);
  for (let i = 0; i < common; i++) {
    const compared = compareDerivationOrder(left.children[i]!, right.children[i]!);
    if (compared !== 0) return compared;
  }
  if (left.children.length !== right.children.length)
    return left.children.length < right.children.length ? -1 : 1;
  if (left.occurrence === right.occurrence) return 0;
  return left.occurrence < right.occurrence ? -1 : 1;
}

interface Cursor<T> {
  readonly iterator: Iterator<OrderedValue<T>>;
  current: OrderedValue<T>;
}

/** Merge already ordered streams without changing multiplicity. */
function* mergeOrdered<T>(
  streams: readonly Iterable<OrderedValue<T>>[],
): Generator<OrderedValue<T>> {
  const cursors: Cursor<T>[] = [];
  for (const stream of streams) {
    const iterator = stream[Symbol.iterator]();
    const first = iterator.next();
    if (!first.done) cursors.push({ iterator, current: first.value });
  }
  while (cursors.length > 0) {
    let least = 0;
    for (let i = 1; i < cursors.length; i++)
      if (compareDerivationOrder(cursors[i]!.current.order, cursors[least]!.current.order) < 0)
        least = i;
    const cursor = cursors[least]!;
    yield cursor.current;
    const next = cursor.iterator.next();
    if (next.done) cursors.splice(least, 1);
    else cursor.current = next.value;
  }
}

function* enumerateProduct<T>(
  derivation: OrderedDerivation<T>,
  childIndex: number,
  childValues: T[],
  childOrders: DerivationOrder[],
): Generator<OrderedValue<T>> {
  if (childIndex === derivation.children.length) {
    yield {
      order: {
        choice: derivation.choice,
        children: [...childOrders],
        occurrence: derivation.occurrence,
      },
      value: derivation.build(childValues),
    };
    return;
  }
  for (const child of enumerateOrderedAnswer(derivation.children[childIndex]!)) {
    childValues.push(child.value);
    childOrders.push(child.order);
    yield* enumerateProduct(derivation, childIndex + 1, childValues, childOrders);
    childOrders.pop();
    childValues.pop();
  }
}

function enumerateOrderedDerivation<T>(
  derivation: OrderedDerivation<T>,
): Iterable<OrderedValue<T>> {
  return enumerateProduct(derivation, 0, [], []);
}

/** Enumerate one logical answer in the source DFS order represented by its packed alternatives. */
export function enumerateOrderedAnswer<T>(answer: OrderedAnswer<T>): Iterable<OrderedValue<T>> {
  return mergeOrdered(answer.derivations.map(enumerateOrderedDerivation));
}

/** Enumerate all logical answers as the exact ordered bag represented by their shared circuit. */
export function enumerateOrderedAnswers<T>(
  answers: readonly OrderedAnswer<T>[],
): Iterable<OrderedValue<T>> {
  return mergeOrdered(answers.map(enumerateOrderedAnswer));
}

/** Count represented outputs without expanding the circuit. Returns `limit + 1` on saturation. */
function countAnswer<T>(
  answer: OrderedAnswer<T>,
  limit: bigint,
  memo: Map<OrderedAnswer<T>, bigint>,
  active: Set<OrderedAnswer<T>>,
): bigint {
  const cached = memo.get(answer);
  if (cached !== undefined) return cached;
  if (active.has(answer)) return limit + 1n;
  active.add(answer);
  let total = 0n;
  for (const derivation of answer.derivations) {
    let product = 1n;
    for (const child of derivation.children) {
      product *= countAnswer(child, limit, memo, active);
      if (product > limit) {
        active.delete(answer);
        return limit + 1n;
      }
    }
    total += product;
    if (total > limit) {
      active.delete(answer);
      return limit + 1n;
    }
  }
  active.delete(answer);
  memo.set(answer, total);
  return total;
}

export function countOrderedAnswer<T>(answer: OrderedAnswer<T>, limit: bigint): bigint {
  return countAnswer(answer, limit, new Map(), new Set());
}

/** Count a call's represented ordered bag without materializing its deferred outputs. */
export function countOrderedAnswers<T>(
  answers: readonly OrderedAnswer<T>[],
  limit: bigint,
): bigint {
  const memo = new Map<OrderedAnswer<T>, bigint>();
  const active = new Set<OrderedAnswer<T>>();
  let total = 0n;
  for (const answer of answers) {
    total += countAnswer(answer, limit, memo, active);
    if (total > limit) return limit + 1n;
  }
  return total;
}
