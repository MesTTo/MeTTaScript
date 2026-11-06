// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: compile a stored clause's templates (db.ts Slot and Ground) into JavaScript over cells for the cell machine.
// The head unifies with the argument registers, read mode against bound cells and write mode building for variables,
// and returns the head-failure sign to the candidate loop on a clash; the body runs in chunks split at calls, its
// variables in JS locals within a chunk and in environment slots across one, a call setting the registers and leaving
// itself pending for the trampoline, a last call leaving the environment first. Ground compound literals are built
// anew per call, as SWI does (a-hp-swi-gap); arithmetic is generic over integers, bigints and floats; tests and
// length/2 run as builtin functions on argument arrays, as the engine's compiled code calls them; if-then-else,
// disjunction and negation become auxiliary predicates tried in order, the clause code generator of the faithful probe
// (ai-tmp/speed/cell/cell2.mjs) over the real control (c-gate-uses-codegen-1106).
// am[implements a-petta-cell-store.compile]

import { Clause, Ground, Pred, Slot } from "../db";
import { Cons, Float, NIL, Str, Struct, type Term } from "../terms";
import { ATM, BOX, INT, LIS, REF, STR, type Heap } from "./heap";
import { CellMachine, ENV, HEADFAIL, type ClauseFn } from "./machine";

const INLINE = new Set(["true/0", "fail/0", "false/0", "!/0", "=/2", "is/2", "</2", ">/2", "=</2", ">=/2", "=:=/2", "=\\=/2", "atom/1", "var/1", "nonvar/1", "integer/1", "length/2"]);

const unwrap = (t: Term): Term => (t instanceof Ground ? t.t : t);
const isSlot = (t: unknown): t is Slot => t instanceof Slot;
const isCompound = (t: Term): boolean => {
  const u = unwrap(t);
  return u instanceof Cons || (u instanceof Struct && u.args.length > 0);
};
function slotsOf(t: Term, out: number[] = []): number[] {
  if (isSlot(t)) out.push(t.i);
  else if (t instanceof Struct) for (const a of t.args) slotsOf(a, out);
  else if (t instanceof Cons) {
    slotsOf(t.head, out);
    slotsOf(t.tail, out);
  }
  return out;
}
const gname = (g: Term): string => {
  const u = unwrap(g);
  return u instanceof Struct ? u.name + "/" + u.args.length : String(u) + "/0";
};
const goalArgs = (g: Term): Term[] => {
  const u = unwrap(g);
  if (!(u instanceof Struct)) return [];
  // A ground goal's compound arguments stay ground holders, so they are copied per call.
  return g instanceof Ground ? u.args.map((a) => (a instanceof Struct || a instanceof Cons ? (new Ground(a) as unknown as Term) : a)) : u.args;
};
function flatConj(t: Term, out: Term[] = []): Term[] {
  const u = unwrap(t);
  if (u instanceof Struct && u.name === "," && u.args.length === 2) {
    const [a, b] = goalArgs(t) as [Term, Term];
    flatConj(a, out);
    flatConj(b, out);
  } else out.push(t);
  return out;
}

// Generic arithmetic over cells, as arith.ts evaluates: integers stay numbers while safe, bigints beyond.
function evalCell(hp: Heap, c: number): number | bigint | Float {
  c = hp.deref(c);
  switch (c & 7) {
    case INT:
      return c >> 3;
    case BOX:
      return hp.boxes[c >> 3] as number | bigint | Float;
    case REF:
      throw new Error("instantiation error in arithmetic");
  }
  throw new Error("type error: evaluable");
}
function sub(a: number | bigint | Float, b: number | bigint | Float): number | bigint | Float {
  if (typeof a === "number" && typeof b === "number") {
    const r = a - b;
    return Number.isSafeInteger(r) ? r : BigInt(a) - BigInt(b);
  }
  if (a instanceof Float || b instanceof Float) return new Float((a instanceof Float ? a.v : Number(a)) - (b instanceof Float ? b.v : Number(b)));
  return BigInt(a) - BigInt(b);
}
function add(a: number | bigint | Float, b: number | bigint | Float): number | bigint | Float {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    return Number.isSafeInteger(r) ? r : BigInt(a) + BigInt(b);
  }
  if (a instanceof Float || b instanceof Float) return new Float((a instanceof Float ? a.v : Number(a)) + (b instanceof Float ? b.v : Number(b)));
  return BigInt(a) + BigInt(b);
}
function num(hp: Heap, v: number | bigint | Float): number {
  return v instanceof Float ? hp.box(v) : hp.int(v);
}
function cmp(op: string, x: number | bigint | Float, y: number | bigint | Float): boolean {
  const a = x instanceof Float ? x.v : x, b = y instanceof Float ? y.v : y;
  const c = a < b ? -1 : a > b ? 1 : 0;
  switch (op) {
    case "<": return c < 0;
    case ">": return c > 0;
    case "=<": return c <= 0;
    case ">=": return c >= 0;
    case "=:=": return c === 0;
    case "=\\=": return c !== 0;
  }
  throw new Error(op);
}
// Tests and length/2 as builtin functions on an argument array (the engine's compiled code calls them so).
const TESTS: Record<string, (cm: CellMachine, a: number[]) => boolean> = {
  "atom/1": (cm, a) => {
    const c = cm.hp.deref(a[0]!);
    return (c & 7) === ATM && c !== cm.hp.NIL;
  },
  "var/1": (cm, a) => {
    const c = cm.hp.deref(a[0]!) & 7;
    return c === REF || c === 7;
  },
  "nonvar/1": (cm, a) => {
    const c = cm.hp.deref(a[0]!) & 7;
    return c !== REF && c !== 7;
  },
  "integer/1": (cm, a) => {
    const c = cm.hp.deref(a[0]!);
    if ((c & 7) === INT) return true;
    if ((c & 7) !== BOX) return false;
    const v = cm.hp.boxes[c >> 3];
    return typeof v === "number" || typeof v === "bigint";
  },
};
/** length/2 in the mode the call gives: the proper list's length unified with N; null when its generator must run. */
function lengthDetMode(cm: CellMachine, a: number[]): boolean | null {
  const hp = cm.hp;
  let k = 0, c = hp.deref(a[0]!);
  while ((c & 7) === LIS) {
    k++;
    c = hp.deref(hp.h[(c >> 3) + 1]!);
  }
  if (c !== hp.NIL) return null;
  return hp.unify(a[1]!, hp.int(k));
}

let auxCount = 0;

/** Compile clause `c` for `cm`. Time: linear in the clause, plus V8 compiling the source on its first run. */
export function compileCellClause(cm: CellMachine, c: Clause): ClauseFn {
  const hp = cm.hp;
  const head = c.head;
  const headArgs: Term[] = head instanceof Struct ? head.args : [];
  const consts: unknown[] = [];
  const k = (x: unknown): string => `K[${consts.push(x) - 1}]`;
  const atomic = (t0: Term): number => {
    const t = unwrap(t0);
    if (typeof t === "string") return hp.atom(t);
    if (typeof t === "number" || typeof t === "bigint") return hp.int(t);
    if (t === NIL) return hp.NIL;
    if (t instanceof Float || t instanceof Str) return hp.box(t);
    if (t instanceof Struct && t.args.length === 0) throw new Error("cell compiler: a compound of no arguments");
    throw new Error("cell compiler: not atomic");
  };
  // Control constructs become auxiliary predicates over the slots they share with the rest of the clause.
  const lower = (goals: Term[]): Term[] =>
    goals.map((g, i) => {
      const key = gname(g);
      if (key !== ";/2" && key !== "->/2" && key !== "\\+/1") return g;
      const outside = new Set(slotsOf(head));
      goals.forEach((o, j) => {
        if (j !== i) for (const s of slotsOf(o)) outside.add(s);
      });
      const vs = [...new Set(slotsOf(g))].filter((s) => outside.has(s));
      const name = "$cellaux" + auxCount++;
      const auxHead = new Struct(name, vs.map((s) => new Slot(s) as unknown as Term));
      const args = goalArgs(g);
      const conj = (gs: Term[]): Term => gs.reduceRight((acc, x) => new Struct(",", [x, acc]));
      const bodies: Term[] = [];
      if (key === ";/2" && gname(args[0]!) === "->/2") {
        const [cnd, then] = goalArgs(args[0]!) as [Term, Term];
        bodies.push(conj([cnd, "!", then]), args[1]!);
      } else if (key === ";/2") bodies.push(args[0]!, args[1]!);
      else if (key === "->/2") bodies.push(conj([args[0]!, "!", args[1]!]));
      else bodies.push(conj([args[0]!, "!", "fail"]), "true");
      const pred = new Pred(name, vs.length);
      for (const b of bodies) pred.clauses.push(new Clause(pred, auxHead, b, c.nvars, 0, 0));
      pred.live = pred.clauses.length;
      const proc = cm.proc(name, vs.length);
      proc.aux = { pred, scan: { list: pred.clauses, start: 0, key: null, keyAt: null } };
      return new Struct(name, vs.map((s) => new Slot(s) as unknown as Term));
    });
  const goals = lower(flatConj(c.body).filter((g) => g !== "true"));
  // Chunks: chunk 0 is the head and the goals up to the first call; each later one runs after a call returns.
  const chunks: Term[][] = [[]];
  goals.forEach((g, i) => {
    chunks[chunks.length - 1]!.push(g);
    if (!INLINE.has(gname(g)) && i < goals.length - 1) chunks.push([]);
  });
  const occ = new Map<number, Set<number>>();
  const note = (t: Term, ch: number): void => {
    for (const s of slotsOf(t)) {
      let o = occ.get(s);
      if (o === undefined) occ.set(s, (o = new Set()));
      o.add(ch);
    }
  };
  note(head, 0);
  chunks.forEach((gs, ch) => gs.forEach((g) => note(g, ch)));
  const perm = [...occ.keys()].filter((s) => occ.get(s)!.size > 1);
  const slot = new Map(perm.map((s, i) => [s, i]));
  const env = chunks.length > 1;
  let seen = new Set<number>();
  let fresh = 0;
  let temps: number[] = [];
  const vx = (s: number): string => (slot.has(s) ? `S[e + ${ENV + slot.get(s)!}]` : `v${s}`);
  const nm = (p: string): string => `${p}${fresh++}`;
  const declare = (s: number): void => {
    if (!slot.has(s) && !temps.includes(s)) temps.push(s);
  };

  function storeArg(a0: Term, addr: string): string {
    const a = unwrap(a0);
    if (isSlot(a)) {
      if (!seen.has(a.i)) {
        seen.add(a.i);
        declare(a.i);
        return `H[${addr}] = (${addr}) << 3; ${vx(a.i)} = (${addr}) << 3; `;
      }
      return `H[${addr}] = ${vx(a.i)}; `;
    }
    if (!isCompound(a)) return `H[${addr}] = ${atomic(a)}; `;
    const [code, cell] = build(a);
    return `${code}H[${addr}] = ${cell}; `;
  }
  /** Write mode: build a compound at the heap top and give the cell pointing at it. */
  function build(t0: Term): [string, string] {
    const t = unwrap(t0);
    const q = nm("q");
    if (t instanceof Cons) return [`const ${q} = t; t += 2; ${storeArg(t.head, q)}${storeArg(t.tail, `${q} + 1`)}`, `((${q} << 3) | ${LIS})`];
    const s = t as Struct;
    const n = s.args.length;
    let code = `const ${q} = t; t += ${n + 1}; H[${q}] = ${hp.functor(s.name, n)}; `;
    s.args.forEach((a, i) => {
      code += storeArg(a, `${q} + ${i + 1}`);
    });
    return [code, `((${q} << 3) | ${STR})`];
  }
  /** Head: unify template t with the cell src gives; a clash returns the head-failure sign. */
  function get(t0: Term, src: string): string {
    const t = unwrap(t0);
    if (isSlot(t)) {
      if (!seen.has(t.i)) {
        seen.add(t.i);
        declare(t.i);
        return `${vx(t.i)} = ${src}; `;
      }
      return `if (!hp.unify(${vx(t.i)}, ${src})) return HF; `;
    }
    const d = nm("d");
    if (!isCompound(t)) {
      const C = atomic(t);
      // A box (float, string, bigint) equals another by content, so a bound cell is compared through unification.
      if ((C & 7) === BOX)
        return `{ const ${d} = hp.deref(${src}); if ((${d} & 7) === 0) hp.bind(${d} >> 3, ${C}); else if (${d} !== ${C} && !hp.unify(${d}, ${C})) return HF; } `;
      // An atom or a small integer is one canonical cell (Heap.atom, Heap.int), so any other bound cell clashes; an
      // attributed variable takes it through unification, which records its wakeup.
      return `{ const ${d} = hp.deref(${src}); if (${d} !== ${C}) { if ((${d} & 7) === 0) hp.bind(${d} >> 3, ${C}); else if ((${d} & 7) !== 7 || !hp.unify(${d}, ${C})) return HF; } } `;
    }
    const p = nm("p"), before = new Set(seen);
    let read: string;
    if (t instanceof Cons) read = `const ${p} = ${d} >> 3; ${get(t.head, `H[${p}]`)}${get(t.tail, `H[${p} + 1]`)}`;
    else {
      const s = t as Struct;
      read = `const ${p} = ${d} >> 3; if (H[${p}] !== ${hp.functor(s.name, s.args.length)}) return HF; `;
      s.args.forEach((a, i) => {
        read += get(a, `H[${p} + ${i + 1}]`);
      });
    }
    const after = seen;
    seen = before;
    const [code, cell] = build(t);
    seen = after;
    // An unbound attributed variable takes the built term through unification, which records its wakeup.
    return `{ const ${d} = hp.deref(${src}); if ((${d} & 7) === 0) { ${code}hp.bind(${d} >> 3, ${cell}); } else if ((${d} & 7) === ${t instanceof Cons ? LIS : STR}) { ${read}} else if ((${d} & 7) === 7) { ${code}hp.top = t; if (!hp.unify(${d}, ${cell})) return HF; } else return HF; } `;
  }
  /** Put: the cell for a call argument or an operand. */
  function put(t0: Term): [string, string] {
    const t = unwrap(t0);
    if (isSlot(t)) {
      if (!seen.has(t.i)) {
        seen.add(t.i);
        declare(t.i);
        const a = nm("n");
        return [`const ${a} = t++; H[${a}] = ${a} << 3; ${vx(t.i)} = ${a} << 3; `, vx(t.i)];
      }
      return ["", vx(t.i)];
    }
    if (!isCompound(t)) return ["", String(atomic(t))];
    return build(t);
  }
  function arith(t0: Term): string {
    const t = unwrap(t0);
    if (isSlot(t)) {
      const [code, v] = put(t);
      if (code) throw new Error("cell compiler: unbound variable in arithmetic");
      return `E(${v})`;
    }
    if (typeof t === "number") return `${t}`;
    if (t instanceof Struct && t.args.length === 2 && (t.name === "-" || t.name === "+"))
      return `${t.name === "-" ? "SUB" : "ADD"}(${arith(t.args[0]!)}, ${arith(t.args[1]!)})`;
    throw new Error("cell compiler: arithmetic outside the gate's subset: " + gname(t));
  }
  function inline(g: Term, ch: number): string {
    const key = gname(g);
    const args = goalArgs(g);
    switch (key) {
      case "true/0":
        return "";
      case "fail/0":
      case "false/0":
        return "hp.top = t; return cm.fail(); ";
      case "!/0":
        return ch === 0 ? "cm.cutTo(b0); " : "cm.cutTo(S[e + 2]); ";
      case "=/2": {
        const [x, y] = args.map(unwrap) as [Term, Term];
        if (isSlot(x) && !seen.has(x.i)) {
          const [cy, vy] = put(y);
          seen.add(x.i);
          declare(x.i);
          return `${cy}${vx(x.i)} = ${vy}; `;
        }
        if (isSlot(y) && !seen.has(y.i)) {
          const [cx, vv] = put(x);
          seen.add(y.i);
          declare(y.i);
          return `${cx}${vx(y.i)} = ${vv}; `;
        }
        const [cx, vv] = put(x), [cy, vy] = put(y);
        return `${cx}${cy}hp.top = t; if (!hp.unify(${vv}, ${vy})) return cm.fail(); if (hp.wakeups.length !== 0) throw new Error("cell engine: wakeups are not built yet"); `;
      }
      case "is/2": {
        const e2 = arith(args[1]!), x = unwrap(args[0]!);
        if (isSlot(x) && !seen.has(x.i)) {
          seen.add(x.i);
          declare(x.i);
          return `hp.top = t; ${vx(x.i)} = NUM(${e2}); t = hp.top; `;
        }
        const r = nm("r");
        const [cx, vv] = put(x);
        return `${cx}hp.top = t; const ${r} = NUM(${e2}); t = hp.top; if (!hp.unify(${vv}, ${r})) return cm.fail(); `;
      }
      case "atom/1":
      case "var/1":
      case "nonvar/1":
      case "integer/1": {
        const [cx, v] = put(args[0]!);
        return `${cx}if (!${k(TESTS[key])}(cm, [${v}])) { hp.top = t; return cm.fail(); } `;
      }
      case "length/2": {
        const [cl, vl] = put(args[0]!), [cn, vn] = put(args[1]!);
        return `${cl}${cn}{ hp.top = t; const r = LEN(cm, [${vl}, ${vn}]); if (r === null) throw new Error("cell engine: length/2's generator is not built yet"); t = hp.top; if (!r) return cm.fail(); } `;
      }
      default:
        if (key in { "</2": 1, ">/2": 1, "=</2": 1, ">=/2": 1, "=:=/2": 1, "=\\=/2": 1 })
          return `if (!CMP(${JSON.stringify((unwrap(g) as Struct).name)}, ${arith(args[0]!)}, ${arith(args[1]!)})) { hp.top = t; return cm.fail(); } `;
    }
    throw new Error("cell compiler: inline goal outside the gate's subset: " + key);
  }
  function call(g: Term, last: boolean, nextId: number): string {
    const args = goalArgs(g);
    let code = "";
    const vals = args.map((a) => {
      const [cc0, v] = put(a);
      code += cc0;
      return v;
    });
    vals.forEach((v, i) => {
      code += `A[${i}] = ${v}; `;
    });
    if (!last) code += `R[1] = ${nextId}; `;
    else if (env) code += "R[1] = S[e + 1]; R[0] = S[e]; ";
    const u = unwrap(g);
    const proc = cm.proc(u instanceof Struct ? u.name : String(u), args.length);
    return `${code}hp.top = t; return cm.callLater(${k(proc)}, ${args.length}, cc); `;
  }
  const ids = chunks.map((_, ch) => (ch === 0 ? -1 : cm.CODE.push(null as unknown as never) - 1));
  const fns: string[] = [];
  const reg: [number, string][] = [];
  chunks.forEach((gs, ch) => {
    temps = [];
    let body = "";
    if (ch === 0) {
      headArgs.forEach((a, i) => {
        body += get(a, `A[${i}]`);
      });
      body += `if (hp.wakeups.length !== 0) throw new Error("cell engine: wakeups are not built yet"); `;
    }
    gs.forEach((g, i) => {
      if (INLINE.has(gname(g))) body += inline(g, ch);
      else body += call(g, ch === chunks.length - 1 && i === gs.length - 1, ids[ch + 1]!);
    });
    const endsInCall = gs.length > 0 && !INLINE.has(gname(gs[gs.length - 1]!));
    if (!endsInCall) body += env ? "{ const cp = S[e + 1]; R[0] = S[e]; R[1] = cp; hp.top = t; return CODE[cp]; } " : "hp.top = t; return CODE[R[1]]; ";
    const decl = temps.length > 0 ? `let ${temps.map(vx).join(", ")}; ` : "";
    const name = ch === 0 ? "clause" : `k${ids[ch]}`;
    const entry =
      ch === 0
        ? `let t = hp.top; ${env ? `const e = cm.allocate(${perm.length}, b0, cc); ` : ""}`
        : "const e = R[0]; const cc = S[e + 4]; let t = hp.top; ";
    fns.push(`(function ${name}(${ch === 0 ? "b0, cc" : ""}) { const H = hp.h; ${entry}${decl}${body}})`);
    if (ch > 0) reg.push([ids[ch]!, name]);
  });
  const src = `return [${fns.join(",\n")}];`;
  const made = new Function("cm", "hp", "A", "S", "R", "CODE", "K", "HF", "E", "SUB", "ADD", "NUM", "CMP", "LEN", src) as (...a: unknown[]) => ((...x: unknown[]) => unknown)[];
  const parts = made(
    cm, hp, cm.A, cm.S, cm.R, cm.CODE, consts, HEADFAIL,
    (x: number) => evalCell(hp, x), sub, add, (v: number | bigint | Float) => num(hp, v), cmp, lengthDetMode,
  );
  reg.forEach(([id], i) => {
    cm.CODE[id] = parts[i + 1] as unknown as never;
  });
  return parts[0] as unknown as ClauseFn;
}
