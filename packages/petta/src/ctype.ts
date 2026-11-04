// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: SWI-Prolog's char_type/2 and code_type/2, ported from swipl-devel src/os/pl-ctype.c (V10.1.20): its class
// table in its order, the test and reverse mapping of each class, and its modes: classify a character, enumerate the
// classes of a character, map back from a class argument, or enumerate the characters of a class. SWI's Unicode
// flags (pl-umap.c) are read here from the JavaScript Unicode property escapes they derive from.
// am[implements a-hp-char-type]

import type { Machine } from "./machine";
import { Struct, Var, deref, instantiationError, mkStruct, typeError, type Term } from "./terms";

const UNICODE_MAX = 0x10ffff;
const ch = (c: number): string => String.fromCodePoint(c);
const has = (re: RegExp) => (c: number): boolean => c >= 0 && c <= UNICODE_MAX && re.test(ch(c));

const isAlpha = has(/\p{L}/u);
const isAlnum = has(/[\p{L}\p{N}]/u);
const isDecimal = has(/\p{Nd}/u);
const isSpace = has(/\p{White_Space}/u);
const isZs = has(/\p{Zs}/u);
const isCntrl = has(/[\p{Cc}\p{Cf}]/u);
const isPunct = has(/[\p{P}\p{S}]/u);
const isLower = has(/\p{Lowercase}/u);
const isUpper = has(/\p{Uppercase}/u);
const isTitleOrUpper = has(/[\p{Lu}\p{Lt}]/u);
const isXidStart = has(/\p{XID_Start}/u);
const isXidContinue = has(/\p{XID_Continue}/u);
const isSterm = has(/\p{Sentence_Terminal}/u);
const isPatternSyntax = has(/\p{Pattern_Syntax}/u);
const isUnicodeSymbol = has(/[\p{Sm}\p{Sc}\p{Sk}\p{So}]/u);
const isSeparator = has(/\p{Z}/u);
const isQuoteMark = has(/[\p{Pi}\p{Pf}]/u);
/** Identifier continuation: XID_Continue, or a character whose NFKC form is all XID_Continue (SWI accepts ², not ¼). */
const isIdContinue = (c: number): boolean =>
  c === 95 || isXidContinue(c) || (c >= 0 && c <= UNICODE_MAX && [...ch(c).normalize("NFKC")].every((x) => isXidContinue(x.codePointAt(0)!)));
const isGraph = (c: number): boolean => !isSpace(c) && !isCntrl(c) && has(/[\p{L}\p{M}\p{N}\p{P}\p{S}]/u)(c);
const isAsciiDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAsciiLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const PROLOG_SYMBOLS = "#$&*+-./:<=>?@\\^~";

/** Unicode simple case mappings: a mapping that changes the length (U+00DF to "SS") leaves the character. */
function toUpper(c: number): number {
  const u = [...ch(c).toUpperCase()];
  return u.length === 1 ? u[0]!.codePointAt(0)! : c;
}
function toLower(c: number): number {
  const l = [...ch(c).toLowerCase()];
  return l.length === 1 ? l[0]!.codePointAt(0)! : c;
}

/** Bracket and quote pairs: ASCII and the common Unicode Ps/Pe and Pi/Pf pairs. */
const PAREN: [number, number][] = [
  [0x28, 0x29], [0x5b, 0x5d], [0x7b, 0x7d], [0x2045, 0x2046], [0x207d, 0x207e], [0x2329, 0x232a], [0x27e8, 0x27e9],
  [0x27ea, 0x27eb], [0x2983, 0x2984], [0x3008, 0x3009], [0x300a, 0x300b], [0x300c, 0x300d], [0x300e, 0x300f],
  [0x3010, 0x3011], [0xff08, 0xff09], [0xff3b, 0xff3d], [0xff5b, 0xff5d],
];
const QUOTE: [number, number][] = [
  [0x27, 0x27], [0x22, 0x22], [0x60, 0x60], [0xab, 0xbb], [0x2018, 0x2019], [0x201c, 0x201d], [0x2039, 0x203a],
];
const pairClose = (pairs: [number, number][]) => (c: number): number => pairs.find(([o]) => o === c)?.[1] ?? -1;
const pairOpen = (pairs: [number, number][]) => (c: number): number => pairs.find(([, cl]) => cl === c)?.[0] ?? -1;

/** A decimal digit's weight: its distance from the start of its run of decimal digits, modulo 10. */
function decimalWeight(c: number): number {
  let s = c;
  while (s > 0 && isDecimal(s - 1)) s--;
  return (c - s) % 10;
}

interface CharType {
  readonly name: string;
  readonly arity: 0 | 1;
  /** Arity 0: whether the character is of the class; arity 1: the argument for the character, or -1. */
  readonly test: (c: number) => boolean | number;
  readonly reverse?: (x: number) => number;
  /** Whether the argument of an arity-1 class is a character (char_type) or code (code_type), or always a number. */
  readonly ctx?: "char" | "code";
}

/** pl-ctype.c char_types[], in its order (the order classes are enumerated in). */
const CHAR_TYPES: CharType[] = [
  { name: "alnum", arity: 0, test: isAlnum },
  { name: "alpha", arity: 0, test: isAlpha },
  { name: "csym", arity: 0, test: (c) => c < 128 && (isAsciiLetter(c) || isAsciiDigit(c) || c === 95) },
  { name: "csymf", arity: 0, test: (c) => c < 128 && (isAsciiLetter(c) || c === 95) },
  { name: "prolog_var_start", arity: 0, test: (c) => c === 95 || (isXidStart(c) && isTitleOrUpper(c)) },
  { name: "prolog_atom_start", arity: 0, test: (c) => isXidStart(c) && !isTitleOrUpper(c) },
  { name: "prolog_identifier_continue", arity: 0, test: isIdContinue },
  { name: "decimal", arity: 0, test: isDecimal },
  { name: "decimal", arity: 1, test: (c) => (isDecimal(c) ? decimalWeight(c) : -1), ctx: "code" },
  { name: "prolog_symbol", arity: 0, test: (c) => (c < 256 ? c >= 0 && PROLOG_SYMBOLS.includes(ch(c)) : isUnicodeSymbol(c)) },
  { name: "prolog_solo", arity: 0, test: (c) => c === 33 || c === 44 || c === 59 || c === 124 },
  { name: "pattern_syntax", arity: 0, test: isPatternSyntax },
  { name: "ascii", arity: 0, test: (c) => c >= 0 && c < 128 },
  { name: "white", arity: 0, test: (c) => c === 9 || isZs(c) },
  { name: "cntrl", arity: 0, test: isCntrl },
  { name: "digit", arity: 0, test: isDecimal },
  { name: "print", arity: 0, test: (c) => isGraph(c) || isZs(c) },
  { name: "graph", arity: 0, test: isGraph },
  { name: "lower", arity: 0, test: isLower },
  { name: "upper", arity: 0, test: isUpper },
  { name: "punct", arity: 0, test: isPunct },
  { name: "space", arity: 0, test: isSpace },
  { name: "end_of_file", arity: 0, test: (c) => c === -1 },
  { name: "end_of_line", arity: 0, test: (c) => (c >= 10 && c <= 13) || c === 0x85 || c === 0x2028 || c === 0x2029 },
  { name: "prolog_end_of_line", arity: 0, test: (c) => c === 10 || c === 13 },
  { name: "prolog_layout", arity: 0, test: isSeparator },
  { name: "newline", arity: 0, test: (c) => c === 10 },
  { name: "period", arity: 0, test: isSterm },
  { name: "quote", arity: 0, test: (c) => c === 39 || c === 34 || c === 96 || isQuoteMark(c) },
  { name: "lower", arity: 1, test: (c) => (isLower(c) ? toUpper(c) : -1), reverse: (u) => (isUpper(u) ? toLower(u) : -1), ctx: "char" },
  { name: "upper", arity: 1, test: (c) => (isUpper(c) ? toLower(c) : -1), reverse: (l) => (isLower(l) ? toUpper(l) : -1), ctx: "char" },
  { name: "to_lower", arity: 1, test: toUpper, reverse: toLower, ctx: "char" },
  { name: "to_upper", arity: 1, test: toLower, reverse: toUpper, ctx: "char" },
  { name: "paren", arity: 1, test: pairClose(PAREN), reverse: pairOpen(PAREN), ctx: "char" },
  { name: "quote", arity: 1, test: pairClose(QUOTE), reverse: pairOpen(QUOTE), ctx: "char" },
  {
    name: "digit",
    arity: 1,
    test: (c) => (isAsciiDigit(c) ? c - 48 : -1),
    reverse: (d) => (d >= 0 && d <= 9 ? d + 48 : -1),
  },
  {
    name: "xdigit",
    arity: 1,
    test: (c) => (isAsciiDigit(c) ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1),
    reverse: (d) => (d >= 0 && d <= 9 ? d + 48 : d >= 10 && d <= 15 ? d + 87 : -1),
  },
];

/** A character term's code: a one-character atom, or (code_type) a code; null when unbound. */
function codeOf(t: Term, codes: boolean): number | null {
  const d = deref(t);
  if (d instanceof Var) return null;
  if (typeof d === "string") {
    if (d === "end_of_file") return -1;
    const cs = [...d];
    if (cs.length === 1) return cs[0]!.codePointAt(0)!;
  }
  if (codes && typeof d === "number") return d;
  throw typeError(codes ? "character_code" : "character", d);
}

/**
 * char_type(?Char, ?Type) and code_type(?Code, ?Type) (pl-ctype.c do_char_type): a nondeterministic builtin whose
 * last solution leaves no choicepoint. `codes` selects how characters are returned.
 */
export function* charTypeSolutions(m: Machine, chrT: Term, clsT: Term, codes: boolean): Generator<void, boolean> {
  const cls = deref(clsT);
  const c = codeOf(chrT, codes);
  const charTerm = (x: number): Term => (codes ? x : ch(x));
  const argTerm = (ct: CharType, v: number): Term => (ct.ctx === undefined ? v : ct.ctx === "char" ? charTerm(v) : v);
  if (c === null && cls instanceof Var) throw instantiationError();
  if (c === -1) return m.unify(cls, "end_of_file");
  if (!(cls instanceof Var)) {
    const [name, arity] = typeof cls === "string" ? [cls, 0] : cls instanceof Struct ? [cls.name, cls.args.length] : ["", -1];
    const ct = CHAR_TYPES.find((x) => x.name === name && x.arity === arity);
    if (ct === undefined) throw typeError("char_type", cls);
    if (c !== null) {
      const r = ct.test(c);
      if (ct.arity === 0) return r === true;
      return (r as number) >= 0 && m.unify((cls as Struct).args[0]!, argTerm(ct, r as number));
    }
    if (ct.arity === 1 && ct.reverse !== undefined) {
      const a = deref((cls as Struct).args[0]!);
      if (!(a instanceof Var)) {
        const av = typeof a === "number" ? a : typeof a === "string" && [...a].length === 1 ? a.codePointAt(0)! : null;
        if (av === null) return false;
        const back = ct.reverse(av);
        return back >= 0 && m.unify(chrT, charTerm(back));
      }
    }
    // Every character of the class, in code order.
    for (let x = 0; x <= UNICODE_MAX; x++) {
      const r = ct.test(x);
      if (ct.arity === 0 ? r !== true : (r as number) < 0) continue;
      const mark = m.trailMark();
      if (m.unify(chrT, charTerm(x)) && (ct.arity === 0 || m.unify((cls as Struct).args[0]!, argTerm(ct, r as number)))) {
        if (x === UNICODE_MAX) return true;
        yield;
      }
      m.undoTo(mark);
    }
    return false;
  }
  // Every class of the character, in table order; the last class leaves no choicepoint.
  for (let i = 0; i < CHAR_TYPES.length; i++) {
    const ct = CHAR_TYPES[i]!;
    const r = ct.test(c!);
    if (ct.arity === 0 ? r !== true : (r as number) < 0) continue;
    const term = ct.arity === 0 ? ct.name : mkStruct(ct.name, argTerm(ct, r as number));
    if (i === CHAR_TYPES.length - 1) return m.unify(cls, term);
    const mark = m.trailMark();
    if (m.unify(cls, term)) yield;
    m.undoTo(mark);
  }
  return false;
}
