// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Compile a closed pure expression to ordered choice callbacks. Slots replace per-branch Bindings objects,
// and deterministic integer subtrees stay unboxed until their final result atom is emitted.
import { type Atom, type ExprAtom, atomEq, expr, gbool, gint } from "./atom";
import { ExactAtomSet } from "./atom-set";
import { addInt, cmpIntVal, type IntVal, mulInt, subInt } from "./number";

type Frame = Atom[];
type Emit = (value: Atom) => void;
type AtomNode = (frame: Frame) => Atom;
type IntNode = (frame: Frame) => IntVal;
type BoolNode = (frame: Frame) => boolean;

interface ChoiceNode {
  readonly run: (frame: Frame, emit: Emit) => void;
  readonly one?: AtomNode;
  readonly int?: IntNode;
  readonly bool?: BoolNode;
}

interface CompileState {
  nextSlot: number;
  readonly isConstructorHead: (name: string) => boolean;
  readonly isDataExpression: (atom: ExprAtom) => boolean;
  readonly canApply: (name: string, args: readonly Atom[]) => boolean;
}

interface LetBinding {
  readonly slot: number;
  readonly value: ChoiceNode;
}

const ABORT = Symbol("choice-plan-abort");

function abort(): never {
  throw ABORT;
}

function asInt(a: Atom): IntVal {
  if (a.kind !== "gnd" || a.value.g !== "int") return abort();
  return a.value.n;
}

function asBool(a: Atom): boolean {
  if (a.kind !== "gnd" || a.value.g !== "bool") return abort();
  return a.value.b;
}

function oneChoice(one: AtomNode, int?: IntNode, bool?: BoolNode): ChoiceNode {
  return {
    one,
    ...(int === undefined ? {} : { int }),
    ...(bool === undefined ? {} : { bool }),
    run: (frame, emit) => emit(one(frame)),
  };
}

function compileVariable(a: Atom, scope: ReadonlyMap<string, number>): ChoiceNode | undefined {
  if (a.kind !== "var") return undefined;
  const slot = scope.get(a.name);
  if (slot === undefined) return undefined;
  const one: AtomNode = (frame) => frame[slot] ?? abort();
  return oneChoice(
    one,
    (frame) => asInt(one(frame)),
    (frame) => asBool(one(frame)),
  );
}

function compileTuple(
  a: Extract<Atom, { kind: "expr" }>,
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  const children = a.items.map((item) => compileChoice(item, scope, state));
  if (children.some((child) => child === undefined)) return undefined;
  const nodes = children as ChoiceNode[];
  if (nodes.every((node) => node.one !== undefined)) {
    const one: AtomNode = (frame) => expr(nodes.map((node) => node.one!(frame)));
    return oneChoice(one);
  }
  return {
    run(frame, emit) {
      const values = new Array<Atom>(nodes.length);
      const visit = (index: number): void => {
        if (index === nodes.length) {
          emit(expr(values.slice()));
          return;
        }
        nodes[index]!.run(frame, (value) => {
          values[index] = value;
          visit(index + 1);
        });
      };
      visit(0);
    },
  };
}

function compileBinaryChoices(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): readonly [ChoiceNode, ChoiceNode] | undefined {
  if (args.length !== 2) return undefined;
  const left = compileChoice(args[0]!, scope, state);
  const right = compileChoice(args[1]!, scope, state);
  return left === undefined || right === undefined ? undefined : [left, right];
}

function compileIntBinary(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
  operation: (left: IntVal, right: IntVal) => IntVal,
): ChoiceNode | undefined {
  const nodes = compileBinaryChoices(args, scope, state);
  if (nodes === undefined) return undefined;
  const [left, right] = nodes;
  if (left.int !== undefined && right.int !== undefined) {
    const int: IntNode = (frame) => operation(left.int!(frame), right.int!(frame));
    return oneChoice((frame) => gint(int(frame)), int);
  }
  return {
    run(frame, emit) {
      left.run(frame, (leftAtom) => {
        const leftValue = asInt(leftAtom);
        right.run(frame, (rightAtom) => emit(gint(operation(leftValue, asInt(rightAtom)))));
      });
    },
  };
}

function compileComparison(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
  predicate: (comparison: number) => boolean,
): ChoiceNode | undefined {
  const nodes = compileBinaryChoices(args, scope, state);
  if (nodes === undefined) return undefined;
  const [left, right] = nodes;
  if (left.int !== undefined && right.int !== undefined) {
    const bool: BoolNode = (frame) => predicate(cmpIntVal(left.int!(frame), right.int!(frame)));
    return oneChoice((frame) => gbool(bool(frame)), undefined, bool);
  }
  return {
    run(frame, emit) {
      left.run(frame, (leftAtom) => {
        const leftValue = asInt(leftAtom);
        right.run(frame, (rightAtom) =>
          emit(gbool(predicate(cmpIntVal(leftValue, asInt(rightAtom))))),
        );
      });
    },
  };
}

function compileEquality(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
  expectEqual: boolean,
): ChoiceNode | undefined {
  const nodes = compileBinaryChoices(args, scope, state);
  if (nodes === undefined) return undefined;
  const [left, right] = nodes;
  if (left.one !== undefined && right.one !== undefined) {
    const bool: BoolNode = (frame) => atomEq(left.one!(frame), right.one!(frame)) === expectEqual;
    return oneChoice((frame) => gbool(bool(frame)), undefined, bool);
  }
  return {
    run(frame, emit) {
      left.run(frame, (leftAtom) =>
        right.run(frame, (rightAtom) => emit(gbool(atomEq(leftAtom, rightAtom) === expectEqual))),
      );
    },
  };
}

function compileIf(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  if (args.length !== 3) return undefined;
  const condition = compileChoice(args[0]!, scope, state);
  const thenNode = compileChoice(args[1]!, scope, state);
  const elseNode = compileChoice(args[2]!, scope, state);
  if (condition === undefined || thenNode === undefined || elseNode === undefined) return undefined;
  if (condition.bool !== undefined && thenNode.one !== undefined && elseNode.one !== undefined) {
    const one: AtomNode = (frame) =>
      condition.bool!(frame) ? thenNode.one!(frame) : elseNode.one!(frame);
    return oneChoice(one);
  }
  return {
    run(frame, emit) {
      condition.run(frame, (conditionAtom) =>
        (asBool(conditionAtom) ? thenNode : elseNode).run(frame, emit),
      );
    },
  };
}

function compileSuperpose(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  if (args.length !== 1) return undefined;
  const source = compileChoice(args[0]!, scope, state);
  if (source === undefined) return undefined;
  return {
    run(frame, emit) {
      source.run(frame, (value) => {
        if (value.kind !== "expr") return abort();
        for (const item of value.items) emit(item);
      });
    },
  };
}

function compileLetBindings(
  pairs: readonly Atom[],
  body: Atom,
  outerScope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  const scope = new Map(outerScope);
  const bindings: LetBinding[] = [];
  for (const pair of pairs) {
    if (pair.kind !== "expr" || pair.items.length !== 2 || pair.items[0]!.kind !== "var")
      return undefined;
    const value = compileChoice(pair.items[1]!, scope, state);
    if (value === undefined) return undefined;
    const slot = state.nextSlot++;
    scope.set(pair.items[0]!.name, slot);
    bindings.push({ slot, value });
  }
  const result = compileChoice(body, scope, state);
  if (result === undefined) return undefined;
  return {
    run(frame, emit) {
      const visit = (index: number): void => {
        if (index === bindings.length) {
          result.run(frame, emit);
          return;
        }
        const binding = bindings[index]!;
        binding.value.run(frame, (value) => {
          frame[binding.slot] = value;
          visit(index + 1);
        });
      };
      visit(0);
    },
  };
}

function compileLetStar(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  if (args.length !== 2 || args[0]!.kind !== "expr") return undefined;
  return compileLetBindings(args[0]!.items, args[1]!, scope, state);
}

function compileLet(
  args: readonly Atom[],
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  if (args.length !== 3 || args[0]!.kind !== "var") return undefined;
  return compileLetBindings([expr([args[0]!, args[1]!])], args[2]!, scope, state);
}

function compileChoice(
  a: Atom,
  scope: ReadonlyMap<string, number>,
  state: CompileState,
): ChoiceNode | undefined {
  const variable = compileVariable(a, scope);
  if (variable !== undefined) return variable;
  if (a.kind === "gnd") {
    if (a.value.g === "int") {
      const value = a.value.n;
      return oneChoice(
        () => a,
        () => value,
      );
    }
    if (a.value.g === "bool") {
      const value = a.value.b;
      return oneChoice(
        () => a,
        undefined,
        () => value,
      );
    }
    return oneChoice(() => a);
  }
  if (a.kind === "sym") return state.isConstructorHead(a.name) ? oneChoice(() => a) : undefined;
  if (a.kind !== "expr") return undefined;
  if (a.items.length === 0) return oneChoice(() => a);
  const head = a.items[0]!;
  if (head.kind === "gnd" && head.exec !== undefined) return undefined;
  if (head.kind !== "sym")
    return state.isDataExpression(a) ? compileTuple(a, scope, state) : undefined;
  const args = a.items.slice(1);
  if (!state.canApply(head.name, args)) return undefined;
  switch (head.name) {
    case "+":
      return compileIntBinary(args, scope, state, addInt);
    case "-":
      return compileIntBinary(args, scope, state, subInt);
    case "*":
      return compileIntBinary(args, scope, state, mulInt);
    case "<":
      return compileComparison(args, scope, state, (comparison) => comparison < 0);
    case "<=":
      return compileComparison(args, scope, state, (comparison) => comparison <= 0);
    case ">":
      return compileComparison(args, scope, state, (comparison) => comparison > 0);
    case ">=":
      return compileComparison(args, scope, state, (comparison) => comparison >= 0);
    case "==":
      return compileEquality(args, scope, state, true);
    case "!=":
      return compileEquality(args, scope, state, false);
    case "if":
      return compileIf(args, scope, state);
    case "superpose":
      return compileSuperpose(args, scope, state);
    case "let":
      return compileLet(args, scope, state);
    case "let*":
      return compileLetStar(args, scope, state);
    default:
      return state.isConstructorHead(head.name) ? compileTuple(a, scope, state) : undefined;
  }
}

/** Evaluate a closed expression in the pure choice fragment. Undefined means the caller must interpret it. */
export function runChoicePlan(
  atom: Atom,
  isConstructorHead: (name: string) => boolean,
  isDataExpression: (atom: ExprAtom) => boolean,
  canApply: (name: string, args: readonly Atom[]) => boolean,
): Atom[] | undefined {
  return runChoicePlanBound(atom, new Map(), isConstructorHead, isDataExpression, canApply);
}

/** Evaluate a choice expression with ground values already assigned to its free parameter names. */
export function runChoicePlanBound(
  atom: Atom,
  bindings: ReadonlyMap<string, Atom>,
  isConstructorHead: (name: string) => boolean,
  isDataExpression: (atom: ExprAtom) => boolean,
  canApply: (name: string, args: readonly Atom[]) => boolean,
): Atom[] | undefined {
  const results: Atom[] = [];
  return visitChoicePlanBound(
    atom,
    bindings,
    isConstructorHead,
    isDataExpression,
    canApply,
    (value) => results.push(value),
  )
    ? results
    : undefined;
}

/** Evaluate a choice expression while retaining only first-seen structural answers. */
export function runDistinctChoicePlan(
  atom: Atom,
  isConstructorHead: (name: string) => boolean,
  isDataExpression: (atom: ExprAtom) => boolean,
  canApply: (name: string, args: readonly Atom[]) => boolean,
): Atom[] | undefined {
  return runDistinctChoicePlanBound(atom, new Map(), isConstructorHead, isDataExpression, canApply);
}

/** Evaluate a bound choice expression without materializing duplicate intermediate answers. */
export function runDistinctChoicePlanBound(
  atom: Atom,
  bindings: ReadonlyMap<string, Atom>,
  isConstructorHead: (name: string) => boolean,
  isDataExpression: (atom: ExprAtom) => boolean,
  canApply: (name: string, args: readonly Atom[]) => boolean,
): Atom[] | undefined {
  const seen = new ExactAtomSet();
  const results: Atom[] = [];
  return visitChoicePlanBound(
    atom,
    bindings,
    isConstructorHead,
    isDataExpression,
    canApply,
    (value) => {
      if (!value.ground) abort();
      if (seen.add(value)) results.push(value);
    },
  )
    ? results
    : undefined;
}

function visitChoicePlanBound(
  atom: Atom,
  bindings: ReadonlyMap<string, Atom>,
  isConstructorHead: (name: string) => boolean,
  isDataExpression: (atom: ExprAtom) => boolean,
  canApply: (name: string, args: readonly Atom[]) => boolean,
  emit: Emit,
): boolean {
  const scope = new Map<string, number>();
  const frame: Atom[] = [];
  for (const [name, value] of bindings) {
    scope.set(name, frame.length);
    frame.push(value);
  }
  const state: CompileState = {
    nextSlot: frame.length,
    isConstructorHead,
    isDataExpression,
    canApply,
  };
  const root = compileChoice(atom, scope, state);
  if (root === undefined) return false;
  try {
    frame.length = state.nextSlot;
    root.run(frame, emit);
    return true;
  } catch (error) {
    if (error === ABORT) return false;
    throw error;
  }
}
