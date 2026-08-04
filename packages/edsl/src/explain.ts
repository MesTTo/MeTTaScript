// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Why a query returned nothing.
//
// `@mettascript/debug` already answers "what did the evaluator do": `explainCall` gives a trace and
// counters. It does not answer this one. On the commonest failure in this eDSL the trace reads
//
//     result: []   trace: [{reduce: "(drinks Ada)"}, {compiled: "drinks"}]   {reductions: 1}
//
// which is true and useless: one reduction, no results, and nothing naming the cause. The cause is
// almost never the evaluator. It is that the pattern and the stored atom differ in one position, and
// most often they differ by METATYPE — the symbol `Ada` against the grounded string `"Ada"`, which look
// identical when printed and never match.
//
// So this compares the pattern against the space directly. It needs no engine change and no trace: the
// eDSL holds both halves already.
import {
  ExpressionAtom,
  SymbolAtom,
  VariableAtom,
  atomToJs,
  type Atom,
} from "@mettascript/hyperon";

/** How close one stored atom came to the pattern. */
export interface NearMiss {
  /** The stored atom, as MeTTa source. */
  readonly atom: string;
  /** Argument position that first differed, 1-based as MeTTa counts arguments. */
  readonly position: number;
  /** What the pattern had there, and what the space had. */
  readonly expected: string;
  readonly actual: string;
  /** Set when the two differ by metatype rather than by value, which is the usual cause. */
  readonly metatypeMismatch?: { readonly expected: string; readonly actual: string };
}

/** Why a pattern matched nothing. */
export interface WhyEmpty {
  /** The pattern, as MeTTa source. */
  readonly pattern: string;
  /** A one-line reading, suitable for printing straight out. */
  readonly summary: string;
  /** Stored atoms with the same head and arity, ranked by how far they got. */
  readonly nearMisses: readonly NearMiss[];
  /** Heads in the space, when the pattern's own head appears nowhere. */
  readonly headsInSpace?: readonly string[];
}

/** MeTTa's metatype for an atom, which is what a mismatch usually comes down to. */
function metatypeOf(a: Atom): string {
  if (a instanceof VariableAtom) return "Variable";
  if (a instanceof SymbolAtom) return "Symbol";
  if (a instanceof ExpressionAtom) return "Expression";
  return "Grounded";
}

/** A head as printed, as named, and by metatype. All three are needed: `Likes` and `"Likes"` are a
 *  symbol and a grounded string that share a NAME, print differently, and never match each other. */
interface Head {
  /** As MeTTa prints it: `Likes`, or `"Likes"` with the quotes. */
  readonly text: string;
  /** The name behind it, quotes stripped, so the two spellings can be compared. Absent when the head
   *  could not have been written as a symbol at all. */
  readonly bare: string | undefined;
  readonly metatype: string;
}

function headOf(a: Atom): Head | undefined {
  if (!(a instanceof ExpressionAtom)) return undefined;
  const h = a.children()[0];
  if (h === undefined) return undefined;
  return { text: String(h), bare: bareName(h), metatype: metatypeOf(h) };
}

/** The name behind a head, when there plausibly is one.
 *
 *  A grounded head is usually a string that was meant to be a symbol, and naming it is the whole point of
 *  the message. It can also be an arbitrary value — a function, an object — whose `String()` form is its
 *  source or `[object Object]`, and pasting that into a suggested `sym("…")` helps nobody. Anything that
 *  could not be written as a symbol answers `undefined`, and the message drops the suggestion. */
function bareName(h: Atom): string | undefined {
  if (h instanceof SymbolAtom) return h.name();
  const value: unknown = atomToJs(h);
  if (typeof value !== "string") return undefined;
  return value.length <= 64 && !/[\s()"']/.test(value) ? value : undefined;
}

const sameHead = (a: Head | undefined, b: Head | undefined): boolean =>
  a?.text === b?.text && a?.metatype === b?.metatype;

const arityOf = (a: Atom): number => (a instanceof ExpressionAtom ? a.children().length - 1 : 0);

/** A variable matches anything, so only ground positions can be the reason. */
function firstDifference(pattern: Atom, stored: Atom): NearMiss | undefined {
  if (!(pattern instanceof ExpressionAtom) || !(stored instanceof ExpressionAtom)) return undefined;
  const ps = pattern.children();
  const ss = stored.children();
  for (let i = 1; i < ps.length && i < ss.length; i++) {
    const p = ps[i]!;
    const s = ss[i]!;
    if (p instanceof VariableAtom) continue;
    if (String(p) === String(s)) continue;
    const pm = metatypeOf(p);
    const sm = metatypeOf(s);
    return {
      atom: String(stored),
      position: i,
      expected: String(p),
      actual: String(s),
      ...(pm !== sm ? { metatypeMismatch: { expected: pm, actual: sm } } : {}),
    };
  }
  return undefined;
}

function describe(pattern: Atom, misses: readonly NearMiss[], heads: readonly Head[]): string {
  const head = headOf(pattern);
  if (misses.length === 0) {
    // The head itself differs by metatype: a JS string grounds to a grounded string everywhere, so
    // `["Likes", …]` builds `("Likes" …)` and the space holds `(Likes …)`. Naming this is the whole
    // point — the two print almost alike and the arity message that used to come out here was false.
    if (head !== undefined && head.metatype === "Grounded") {
      const shadow =
        head.bare === undefined
          ? undefined
          : heads.find((h) => h.bare === head.bare && h.metatype === "Symbol");
      const spell =
        head.bare === undefined ? "" : ` — spell it sym("${head.bare}") or names("${head.bare}")`;
      // No space can rescue this: MeTTa applies a rule and matches a functor by SYMBOL head, so a
      // grounded one matches nothing and reduces to itself whatever is stored.
      return shadow === undefined
        ? `the head is Grounded ${head.text}, not a Symbol, so nothing matches it and no rule fires${spell}`
        : `the head is Grounded ${head.text} and the space holds Symbol ${shadow.text}, which never ` +
            `match${spell}`;
    }
    if (head !== undefined && !heads.some((h) => sameHead(h, head)))
      return heads.length === 0
        ? `nothing is stored, so no pattern can match`
        : `no atom in the space is headed ${head.text}; the space has ${heads.map((h) => h.text).join(", ")}`;
    return `atoms headed ${head?.text ?? "like this"} exist but none has ${arityOf(pattern)} argument(s)`;
  }
  const m = misses[0]!;
  const meta = m.metatypeMismatch;
  const why =
    meta === undefined
      ? `the space has ${m.actual}`
      : `you passed ${meta.expected} ${m.expected} and the space holds ${meta.actual} ${m.actual}, which never match`;
  return `argument ${m.position} differs: ${why}`;
}

/** Compare a pattern against a space, and say why nothing matched.
 *
 *  Ranks the stored atoms that share the pattern's head and arity, since those are the ones that nearly
 *  worked, and reports the FIRST argument position where each diverged. A metatype difference is called
 *  out by name because it is both the likeliest cause and the one that is invisible in the printed form:
 *  `Ada` and `"Ada"` are a symbol and a grounded string, and they look alike until you ask. */
export function whyEmpty(pattern: Atom, atoms: readonly Atom[]): WhyEmpty {
  const head = headOf(pattern);
  const arity = arityOf(pattern);
  const heads = [
    ...new Map(
      atoms
        .map(headOf)
        .filter((h): h is Head => h !== undefined)
        .map((h) => [`${h.metatype} ${h.text}`, h] as const),
    ).values(),
  ];

  const sameShape = atoms.filter((a) => sameHead(headOf(a), head) && arityOf(a) === arity);
  const nearMisses = sameShape
    .map((a) => firstDifference(pattern, a))
    .filter((m): m is NearMiss => m !== undefined)
    // the further into the arguments it got, the closer it came
    .sort((a, b) => b.position - a.position);

  return {
    pattern: String(pattern),
    summary: describe(pattern, nearMisses, heads),
    nearMisses,
    ...(head !== undefined && !heads.some((h) => sameHead(h, head))
      ? { headsInSpace: heads.map((h) => h.text) }
      : {}),
  };
}

/** {@link whyEmpty} rendered for a person to read. */
export function formatWhyEmpty(why: WhyEmpty): string {
  const lines = [`${why.pattern} matched nothing: ${why.summary}`];
  for (const m of why.nearMisses.slice(0, 5)) {
    lines.push(`  near: ${m.atom}`);
    lines.push(
      m.metatypeMismatch === undefined
        ? `        argument ${m.position}: wanted ${m.expected}, found ${m.actual}`
        : `        argument ${m.position}: wanted ${m.metatypeMismatch.expected} ${m.expected}, ` +
            `found ${m.metatypeMismatch.actual} ${m.actual}`,
    );
  }
  return lines.join("\n");
}
