// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import {
  type Atom,
  type ExprAtom,
  type VariableId,
  type VarAtom,
  atomEq,
  scopedVariable,
  variable,
  variableIdentity,
  variableIdentityKey,
} from "./atom";
import {
  type Bindings,
  type BindingRel,
  fromRelations,
  makeEqRel,
  makeValRel,
  relations,
} from "./bindings";
import { mapAtomVariables, mapExpressionChildren } from "./map-expression";
import { ForkableMap } from "./persistent-collection";
import { parseRuntimeId } from "./trace";

/** A logic variable as seen by a binding frame. Its display name is never its scoped identity. */
export interface FrameVariable {
  readonly displayName: string;
  readonly id?: VariableId;
}

export interface BindingClassSnapshot {
  readonly representative: FrameVariable;
  readonly members: readonly FrameVariable[];
  readonly value?: Atom;
}

export type BindingFrameFaultCode = "conflict" | "occurs-check" | "cyclic-frame";

export interface BindingFrameFault {
  readonly code: BindingFrameFaultCode;
  readonly message: string;
  readonly variable?: FrameVariable;
  readonly left?: Atom;
  readonly right?: Atom;
}

export type BindingFrameResult<T = BindingFrame> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fault: BindingFrameFault };

interface VariableNode {
  readonly variable: FrameVariable;
  readonly parent: string;
  readonly rank: number;
  /** The class member that sorts first, maintained on root nodes and stale on children. */
  readonly canonical: FrameVariable;
  readonly value?: Atom;
}

// Node stores share structure across frames: a builder forks the store in constant time and each
// write replaces one hash-trie path, so deriving a frame costs the touched nodes, not the frame.
const FRAME_NODES = new WeakMap<BindingFrame, ForkableMap<string, VariableNode>>();

interface FrameDeltaRecord {
  readonly base: BindingFrame;
  readonly touched: ReadonlySet<string>;
}

// Provenance journal for derived frames: which frame a builder started from and which variable
// keys its constraint writes touched. Consumers use it to merge and validate only the delta.
const FRAME_DELTAS = new WeakMap<BindingFrame, FrameDeltaRecord>();

const EMPTY_TOUCHED: ReadonlySet<string> = new Set();

/** Guard for provenance-chain walks; real derivation chains are a handful of operations long. */
const MAX_DELTA_CHAIN = 64;

function frameVariable(variableAtom: VarAtom): FrameVariable {
  const id = variableIdentity(variableAtom);
  return id === undefined
    ? { displayName: variableAtom.name }
    : { displayName: variableAtom.name, id };
}

function frameVariableKey(variableRef: FrameVariable): string {
  return variableIdentityKey(variableRef.displayName, variableRef.id);
}

function frameVariableAtom(variableRef: FrameVariable): VarAtom {
  return variableRef.id === undefined
    ? variable(variableRef.displayName)
    : scopedVariable(variableRef.displayName, variableRef.id);
}

function compareFrameVariables(a: FrameVariable, b: FrameVariable): number {
  return frameVariableKey(a).localeCompare(frameVariableKey(b));
}

function nodesOf(frame: BindingFrame): ForkableMap<string, VariableNode> {
  const nodes = FRAME_NODES.get(frame);
  if (nodes === undefined) throw new Error("BindingFrame invariant: missing node store");
  return nodes;
}

function frameFromNodes(nodes: ForkableMap<string, VariableNode>): BindingFrame {
  const frame = new BindingFrame();
  FRAME_NODES.set(frame, nodes);
  return frame;
}

function collectVariables(atom: Atom, into: Map<string, FrameVariable>): void {
  const stack: Atom[] = [atom];
  const seenExpressions = new Set<ExprAtom>();
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next.ground) continue;
    if (next.kind === "var") {
      const ref = frameVariable(next);
      into.set(frameVariableKey(ref), ref);
      continue;
    }
    if (next.kind !== "expr" || seenExpressions.has(next)) continue;
    seenExpressions.add(next);
    for (let index = next.items.length - 1; index >= 0; index--) stack.push(next.items[index]!);
  }
}

function readonlyRoot(nodes: ForkableMap<string, VariableNode>, key: string): string {
  let current = key;
  for (;;) {
    const node = nodes.get(current);
    if (node === undefined)
      throw new Error(`BindingFrame invariant: unknown variable '${current}'`);
    if (node.parent === current) return current;
    current = node.parent;
  }
}

class BindingFrameBuilder {
  readonly nodes: ForkableMap<string, VariableNode>;
  readonly touched = new Set<string>();

  constructor(frame: BindingFrame) {
    this.nodes = nodesOf(frame).fork();
  }

  #write(key: string, node: VariableNode): void {
    this.nodes.set(key, Object.freeze(node));
    this.touched.add(key);
  }

  /** A path-compression rewrite changes no constraint and stays out of the delta journal. */
  #writeCompressed(key: string, node: VariableNode): void {
    this.nodes.set(key, Object.freeze(node));
  }

  ensure(variableRef: FrameVariable): string {
    const key = frameVariableKey(variableRef);
    const existing = this.nodes.get(key);
    if (existing === undefined) {
      this.#write(key, { variable: variableRef, parent: key, rank: 0, canonical: variableRef });
    } else if (variableRef.displayName < existing.variable.displayName) {
      this.#write(key, { ...existing, variable: variableRef });
      const root = this.find(key);
      const rootNode = this.nodes.get(root)!;
      if (frameVariableKey(rootNode.canonical) === key)
        this.#write(root, { ...rootNode, canonical: variableRef });
    }
    return key;
  }

  ensureAtomVariables(atom: Atom): void {
    const variables = new Map<string, FrameVariable>();
    collectVariables(atom, variables);
    for (const variableRef of variables.values()) this.ensure(variableRef);
  }

  find(key: string): string {
    const path: string[] = [];
    let current = key;
    for (;;) {
      const node = this.nodes.get(current);
      if (node === undefined)
        throw new Error(`BindingFrame invariant: unknown variable '${current}'`);
      if (node.parent === current) break;
      path.push(current);
      current = node.parent;
    }
    for (const child of path) {
      const node = this.nodes.get(child)!;
      if (node.parent !== current) this.#writeCompressed(child, { ...node, parent: current });
    }
    return current;
  }

  rootNode(key: string): VariableNode {
    return this.nodes.get(this.find(key))!;
  }

  occurs(targetRoot: string, atom: Atom): boolean {
    const stack: Atom[] = [atom];
    const visitedRoots = new Set<string>();
    const visitedExpressions = new Set<ExprAtom>();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next.ground) continue;
      if (next.kind === "var") {
        const key = this.ensure(frameVariable(next));
        const root = this.find(key);
        if (root === targetRoot) return true;
        if (visitedRoots.has(root)) continue;
        visitedRoots.add(root);
        const value = this.nodes.get(root)!.value;
        if (value !== undefined) stack.push(value);
        continue;
      }
      if (next.kind !== "expr" || visitedExpressions.has(next)) continue;
      visitedExpressions.add(next);
      for (let index = next.items.length - 1; index >= 0; index--) stack.push(next.items[index]!);
    }
    return false;
  }

  bindVariable(variableAtom: VarAtom, value: Atom): BindingFrameFault | undefined {
    if (value.kind === "var") return this.equateVariables(variableAtom, value);
    const key = this.ensure(frameVariable(variableAtom));
    const root = this.find(key);
    const rootNode = this.nodes.get(root)!;
    if (rootNode.value !== undefined) return this.unify(rootNode.value, value);
    if (this.occurs(root, value)) {
      return {
        code: "occurs-check",
        message: "finite-tree unification rejected a variable inside its own value",
        variable: rootNode.variable,
        right: value,
      };
    }
    this.ensureAtomVariables(value);
    this.#write(root, { ...this.nodes.get(root)!, value });
    return undefined;
  }

  equateVariables(left: VarAtom, right: VarAtom): BindingFrameFault | undefined {
    const leftKey = this.ensure(frameVariable(left));
    const rightKey = this.ensure(frameVariable(right));
    let leftRoot = this.find(leftKey);
    let rightRoot = this.find(rightKey);
    if (leftRoot === rightRoot) return undefined;

    let leftNode = this.nodes.get(leftRoot)!;
    let rightNode = this.nodes.get(rightRoot)!;
    const leftValue = leftNode.value;
    const rightValue = rightNode.value;
    if (leftValue !== undefined && rightValue !== undefined) {
      const fault = this.unify(leftValue, rightValue);
      if (fault !== undefined) return fault;
      leftRoot = this.find(leftRoot);
      rightRoot = this.find(rightRoot);
      if (leftRoot === rightRoot) return undefined;
      leftNode = this.nodes.get(leftRoot)!;
      rightNode = this.nodes.get(rightRoot)!;
    } else if (leftValue !== undefined && this.occurs(rightRoot, leftValue)) {
      return {
        code: "occurs-check",
        message: "equating variable classes would create a finite-tree cycle",
        variable: rightNode.variable,
        right: leftValue,
      };
    } else if (rightValue !== undefined && this.occurs(leftRoot, rightValue)) {
      return {
        code: "occurs-check",
        message: "equating variable classes would create a finite-tree cycle",
        variable: leftNode.variable,
        right: rightValue,
      };
    }

    let parentRoot = leftRoot;
    let childRoot = rightRoot;
    if (
      leftNode.rank < rightNode.rank ||
      (leftNode.rank === rightNode.rank && rightRoot.localeCompare(leftRoot) < 0)
    ) {
      parentRoot = rightRoot;
      childRoot = leftRoot;
    }
    const parent = this.nodes.get(parentRoot)!;
    const child = this.nodes.get(childRoot)!;
    const value = parent.value ?? child.value;
    const rank = parent.rank === child.rank ? parent.rank + 1 : parent.rank;
    const canonical =
      compareFrameVariables(parent.canonical, child.canonical) <= 0
        ? parent.canonical
        : child.canonical;
    this.#write(parentRoot, {
      ...parent,
      rank,
      canonical,
      ...(value === undefined ? {} : { value }),
    });
    this.#write(childRoot, {
      variable: child.variable,
      parent: parentRoot,
      rank: child.rank,
      canonical: child.canonical,
    });
    return undefined;
  }

  unify(left: Atom, right: Atom): BindingFrameFault | undefined {
    const pending: Array<readonly [Atom, Atom]> = [[left, right]];
    while (pending.length > 0) {
      const [nextLeft, nextRight] = pending.pop()!;
      if (nextLeft.kind === "var" && nextRight.kind === "var") {
        const fault = this.equateVariables(nextLeft, nextRight);
        if (fault !== undefined) return fault;
        continue;
      }
      if (nextLeft.kind === "var") {
        const fault = this.bindVariable(nextLeft, nextRight);
        if (fault !== undefined) return fault;
        continue;
      }
      if (nextRight.kind === "var") {
        const fault = this.bindVariable(nextRight, nextLeft);
        if (fault !== undefined) return fault;
        continue;
      }
      if (nextLeft.kind === "expr" && nextRight.kind === "expr") {
        if (nextLeft.items.length !== nextRight.items.length)
          return {
            code: "conflict",
            message: "expressions with different arities do not unify",
            left: nextLeft,
            right: nextRight,
          };
        for (let index = nextLeft.items.length - 1; index >= 0; index--)
          pending.push([nextLeft.items[index]!, nextRight.items[index]!]);
        continue;
      }
      if (!atomEq(nextLeft, nextRight))
        return {
          code: "conflict",
          message: "atoms do not unify",
          left: nextLeft,
          right: nextRight,
        };
    }
    return undefined;
  }

  replayClass(
    bindingClass: BindingClassSnapshot,
    members: readonly FrameVariable[] = bindingClass.members,
  ): BindingFrameFault | undefined {
    if (members.length === 0) return undefined;
    const representative = frameVariableAtom(members[0]!);
    for (const member of members.slice(1)) {
      const fault = this.equateVariables(representative, frameVariableAtom(member));
      if (fault !== undefined) return fault;
    }
    return bindingClass.value === undefined
      ? undefined
      : this.bindVariable(representative, bindingClass.value);
  }

  finish(base?: BindingFrame): BindingFrame {
    const frame = frameFromNodes(this.nodes);
    if (base !== undefined) FRAME_DELTAS.set(frame, { base, touched: this.touched });
    return frame;
  }
}

function canonicalMembers(nodes: ForkableMap<string, VariableNode>): Map<string, FrameVariable[]> {
  const grouped = new Map<string, FrameVariable[]>();
  for (const [key, node] of nodes) {
    const root = readonlyRoot(nodes, key);
    const members = grouped.get(root);
    if (members === undefined) grouped.set(root, [node.variable]);
    else members.push(node.variable);
  }
  for (const members of grouped.values()) members.sort(compareFrameVariables);
  return grouped;
}

function resolveAtom(
  frame: BindingFrame,
  atom: Atom,
  visitingRoots: Set<string>,
  expressionMemo: Map<ExprAtom, Atom>,
): Atom {
  if (atom.ground) return atom;
  if (atom.kind === "var") {
    const nodes = nodesOf(frame);
    const key = frameVariableKey(frameVariable(atom));
    if (!nodes.has(key)) return atom;
    const root = readonlyRoot(nodes, key);
    const node = nodes.get(root)!;
    if (node.value === undefined) return frameVariableAtom(node.canonical);
    if (visitingRoots.has(root))
      throw new Error("BindingFrame invariant: cyclic frame reached during instantiation");
    visitingRoots.add(root);
    const result = resolveAtom(frame, node.value, visitingRoots, expressionMemo);
    visitingRoots.delete(root);
    return result;
  }
  if (atom.kind !== "expr") return atom;
  return mapExpressionChildren(atom, expressionMemo, (item) =>
    resolveAtom(frame, item, visitingRoots, expressionMemo),
  );
}

/**
 * The variable keys `frame` touched since `base`, when `frame` is a recorded monotone derivation
 * of `base` (each step a `unify`, `bind`, `equate`, or `merge` on the previous frame). Returns
 * `undefined` for unrelated frames.
 */
export function frameTouchedSince(
  base: BindingFrame,
  frame: BindingFrame,
): ReadonlySet<string> | undefined {
  if (frame === base) return EMPTY_TOUCHED;
  const record = FRAME_DELTAS.get(frame);
  if (record === undefined) return undefined;
  if (record.base === base) return record.touched;
  const touched = new Set<string>(record.touched);
  let current = record.base;
  for (let hops = 1; hops < MAX_DELTA_CHAIN; hops += 1) {
    const next = FRAME_DELTAS.get(current);
    if (next === undefined) return undefined;
    for (const key of next.touched) touched.add(key);
    if (next.base === base) return touched;
    current = next.base;
  }
  return undefined;
}

export interface FrameDeltaView {
  /** Every member of a class the derivation touched. */
  readonly variables: readonly FrameVariable[];
  /** The raw value of each touched class that carries one. */
  readonly values: readonly Atom[];
}

/**
 * The members and raw class values `frame` added or changed relative to `base`. Untouched classes
 * came from `base` unchanged, so a consumer that already trusts `base` only needs this view.
 * Returns `undefined` when `frame` is not a recorded derivation of `base`.
 */
export function frameDeltaView(
  base: BindingFrame,
  frame: BindingFrame,
): FrameDeltaView | undefined {
  const touched = frameTouchedSince(base, frame);
  if (touched === undefined) return undefined;
  const nodes = nodesOf(frame);
  const variables: FrameVariable[] = [];
  const values: Atom[] = [];
  const seenRoots = new Set<string>();
  for (const key of touched) {
    const node = nodes.get(key);
    if (node === undefined) continue;
    variables.push(node.variable);
    const root = readonlyRoot(nodes, key);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const value = nodes.get(root)!.value;
    if (value !== undefined) values.push(value);
  }
  return { variables, values };
}

/** Immutable finite-tree constraint graph over legacy or scoped variables. */
export class BindingFrame {
  constructor() {
    FRAME_NODES.set(this, new ForkableMap());
  }

  get variableCount(): number {
    return nodesOf(this).size;
  }

  get isEmpty(): boolean {
    for (const [key, node] of nodesOf(this)) {
      if (node.parent !== key || node.value !== undefined) return false;
    }
    return true;
  }

  classes(): readonly BindingClassSnapshot[] {
    const nodes = nodesOf(this);
    const grouped = canonicalMembers(nodes);
    const snapshots: BindingClassSnapshot[] = [];
    for (const [root, members] of grouped) {
      const value = nodes.get(root)!.value;
      snapshots.push({
        representative: members[0]!,
        members: [...members],
        ...(value === undefined
          ? {}
          : { value: resolveAtom(this, value, new Set([root]), new Map()) }),
      });
    }
    snapshots.sort((a, b) => compareFrameVariables(a.representative, b.representative));
    return snapshots;
  }

  unify(left: Atom, right: Atom): BindingFrameResult {
    const builder = new BindingFrameBuilder(this);
    const fault = builder.unify(left, right);
    return fault === undefined ? { ok: true, value: builder.finish(this) } : { ok: false, fault };
  }

  bind(variableAtom: VarAtom, value: Atom): BindingFrameResult {
    return this.unify(variableAtom, value);
  }

  equate(left: VarAtom, right: VarAtom): BindingFrameResult {
    return this.unify(left, right);
  }

  merge(other: BindingFrame): BindingFrameResult {
    // A frame derived from this one by monotone operations already contains every constraint of
    // this frame, so the merge result is the derived frame itself.
    if (frameTouchedSince(this, other) !== undefined) return { ok: true, value: other };
    const builder = new BindingFrameBuilder(this);
    for (const bindingClass of other.classes()) {
      const fault = builder.replayClass(bindingClass);
      if (fault !== undefined) return { ok: false, fault };
    }
    return { ok: true, value: builder.finish(this) };
  }

  /** Rename variable identities while preserving complete equivalence classes and checked values. */
  mapVariables(mapVariable: (variable: VarAtom) => VarAtom): BindingFrameResult {
    const builder = new BindingFrameBuilder(new BindingFrame());
    const memo = new Map<ExprAtom, Atom>();
    for (const bindingClass of this.classes()) {
      const members = bindingClass.members.map((member) =>
        frameVariable(mapVariable(frameVariableAtom(member))),
      );
      const value =
        bindingClass.value === undefined
          ? undefined
          : mapAtomVariables(bindingClass.value, mapVariable, memo);
      const fault = builder.replayClass({
        representative: members[0]!,
        members,
        ...(value === undefined ? {} : { value }),
      });
      if (fault !== undefined) return { ok: false, fault };
    }
    return { ok: true, value: builder.finish() };
  }

  instantiate(atom: Atom): Atom {
    if (atom.ground) return atom;
    return resolveAtom(this, atom, new Set(), new Map());
  }

  resolve(variableAtom: VarAtom): Atom | undefined {
    const key = frameVariableKey(frameVariable(variableAtom));
    if (!nodesOf(this).has(key)) return undefined;
    return this.instantiate(variableAtom);
  }

  /** Keep requested variables and the transitive variables needed by their resolved values. */
  project(variables: readonly VarAtom[]): BindingFrameResult {
    const nodes = nodesOf(this);
    const included = new Map<string, FrameVariable>();
    const rootValues = new Map<string, Atom | undefined>();
    const expressionMemo = new Map<ExprAtom, Atom>();
    const pending = variables.map(frameVariable);
    while (pending.length > 0) {
      const next = pending.pop()!;
      const key = frameVariableKey(next);
      if (included.has(key) || !nodes.has(key)) continue;
      included.set(key, next);
      const root = readonlyRoot(nodes, key);
      if (rootValues.has(root)) continue;
      const raw = nodes.get(root)!.value;
      let resolved: Atom | undefined;
      if (raw !== undefined) {
        resolved = resolveAtom(this, raw, new Set([root]), expressionMemo);
        const dependencies = new Map<string, FrameVariable>();
        collectVariables(resolved, dependencies);
        for (const dependency of dependencies.values()) pending.push(dependency);
      }
      rootValues.set(root, resolved);
    }

    const keptByRoot = new Map<string, FrameVariable[]>();
    for (const [key, variableRef] of included) {
      const root = readonlyRoot(nodes, key);
      const kept = keptByRoot.get(root);
      if (kept === undefined) keptByRoot.set(root, [variableRef]);
      else kept.push(variableRef);
    }
    const builder = new BindingFrameBuilder(new BindingFrame());
    for (const [root, kept] of keptByRoot) {
      kept.sort(compareFrameVariables);
      const value = rootValues.get(root);
      const fault = builder.replayClass(
        { representative: kept[0]!, members: kept, ...(value === undefined ? {} : { value }) },
        kept,
      );
      if (fault !== undefined) return { ok: false, fault };
    }
    return { ok: true, value: builder.finish() };
  }
}

export const emptyBindingFrame = new BindingFrame();

/** Convert the complete legacy relation list into a checked canonical frame. */
export function bindingFrameFromLegacy(bindings: Bindings): BindingFrameResult {
  const builder = new BindingFrameBuilder(new BindingFrame());
  const seenValues = new Set<string>();
  for (const relation of relations(bindings)) {
    let fault: BindingFrameFault | undefined;
    if (relation.tag === "eq") {
      fault = builder.equateVariables(variable(relation.x), variable(relation.y));
    } else {
      if (seenValues.has(relation.x)) continue;
      seenValues.add(relation.x);
      fault = builder.bindVariable(variable(relation.x), relation.a);
    }
    if (fault !== undefined) return { ok: false, fault };
  }
  return { ok: true, value: builder.finish() };
}

class LegacyVariableProjection {
  readonly #names = new Map<string, string>();

  constructor(variables: readonly FrameVariable[]) {
    const reserved = new Set<string>();
    for (const variableRef of variables) {
      if (variableRef.id === undefined) {
        reserved.add(variableRef.displayName);
        this.#names.set(frameVariableKey(variableRef), variableRef.displayName);
      }
    }
    const scoped = variables
      .filter((variableRef) => variableRef.id !== undefined)
      .sort(compareFrameVariables);
    for (const variableRef of scoped) {
      const id = variableRef.id!;
      const sequence = parseRuntimeId(id.scope)?.sequence ?? id.slot;
      let suffix = sequence;
      let candidate = `${variableRef.displayName}#${suffix}`;
      while (reserved.has(candidate)) candidate = `${variableRef.displayName}#${++suffix}`;
      reserved.add(candidate);
      this.#names.set(frameVariableKey(variableRef), candidate);
    }
  }

  name(variableRef: FrameVariable): string {
    const projected = this.#names.get(frameVariableKey(variableRef));
    if (projected === undefined)
      throw new Error("BindingFrame invariant: variable missing from legacy projection");
    return projected;
  }
}

function projectAtomToLegacy(
  atom: Atom,
  projection: LegacyVariableProjection,
  memo: Map<ExprAtom, Atom>,
): Atom {
  if (atom.ground) return atom;
  if (atom.kind === "var") return variable(projection.name(frameVariable(atom)));
  if (atom.kind !== "expr") return atom;
  return mapExpressionChildren(atom, memo, (item) => projectAtomToLegacy(item, projection, memo));
}

/**
 * Project a scoped frame onto the existing string-keyed relation API. Scoped names receive deterministic
 * `#N` suffixes only at this compatibility boundary.
 */
export function bindingFrameToLegacy(frame: BindingFrame): Bindings {
  const classes = frame.classes();
  const variables = classes.flatMap((bindingClass) => [...bindingClass.members]);
  const projection = new LegacyVariableProjection(variables);
  const output: BindingRel[] = [];
  const atomMemo = new Map<ExprAtom, Atom>();
  for (const bindingClass of classes) {
    const names = bindingClass.members.map((member) => projection.name(member));
    if (bindingClass.value !== undefined) {
      const value = projectAtomToLegacy(bindingClass.value, projection, atomMemo);
      for (const name of names) output.push(makeValRel(name, value));
    }
    for (let index = 1; index < names.length; index++)
      output.push(makeEqRel(names[0]!, names[index]!));
  }
  return fromRelations(output);
}
