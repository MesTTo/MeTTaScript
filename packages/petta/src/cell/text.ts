// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the text conversion builtins on cells: atom_codes/2, atom_chars/2, string_codes/2, string_chars/2,
// number_codes/2, number_chars/2, atom_string/2, string_to_atom/2 and split_string/4, which PeTTa's reader calls for
// every token and line of a file it parses. Each reads its text from the cells and builds its answer on the heap,
// giving the object builtin's answer (builtins.ts) without decoding its arguments; a call whose text is not plain, an
// unbound or partial argument, a compound, or a code beyond Unicode, goes to the object builtin through the bridge,
// which answers it and raises its errors.
// am[implements a-petta-speed-general-1108.load.text]

import { parseNumber, splitFields } from "../builtins";
import { Float, Str, formatFloat } from "../terms";
import { ATM, ATV, BOX, INT, LIS, REF, STR, type Heap } from "./heap";
import type { CellMachine } from "./machine";

/**
 * The text of cell `c0` as textOf (terms.ts) reads its term: an atom's name, a string's text, a number's written form,
 * [] as the empty text, and a list of codes or one-character atoms joined. Null for anything else: an unbound cell, a
 * compound, a partial list, a list element that is neither, and a code past U+10FFFF, which String.fromCodePoint
 * refuses. A cyclic list loops, as listToArray does. Time: the text's length.
 */
export function textOfCell(hp: Heap, c0: number): string | null {
  const c = hp.deref(c0);
  switch (c & 7) {
    case ATM:
      return c === hp.NIL ? "" : hp.atomNames[c >> 3]!;
    case INT:
      return String(c >> 3);
    case BOX: {
      const v = hp.boxed(c);
      if (v instanceof Str) return v.s;
      if (v instanceof Float) return formatFloat(v.v);
      return typeof v === "number" || typeof v === "bigint" ? String(v) : null;
    }
    case LIS:
      return listText(hp, c);
  }
  return null;
}

/** The text of list cell `c0` of codes and one-character atoms, or null (textOfCell). Time: the list's length. */
function listText(hp: Heap, c0: number): string | null {
  const h = hp.h;
  let s = "", c = c0;
  while ((c & 7) === LIS) {
    const x = hp.deref(h[c >> 3]!);
    if ((x & 7) === INT) {
      const code = x >> 3;
      if (code < 0 || code > 0x10ffff) return null;
      s += String.fromCodePoint(code);
    } else if ((x & 7) === ATM && x !== hp.NIL) {
      const name = hp.atomNames[x >> 3]!;
      if (name.length !== 1 && !(name.length === 2 && name.codePointAt(0)! > 0xffff)) return null;
      s += name;
    } else return null;
    c = hp.deref(h[(c >> 3) + 1]!);
  }
  return c === hp.NIL ? s : null;
}

/** The code points of `s`, as [...s] counts them: a lone surrogate is one. Time: |s|. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; n++) i += s.codePointAt(i)! > 0xffff ? 2 : 1;
  return n;
}

/**
 * The list of `s`'s code points ending in `tail`, built on the heap in one block, each element an integer cell, or
 * with `chars` a one-character atom (terms.ts codes and chars). Time: |s|.
 */
export function textListCell(hp: Heap, s: string, chars: boolean, tail: number): number {
  const n = codePoints(s);
  if (n === 0) return tail;
  const a = hp.alloc(2 * n), h = hp.h;
  for (let i = 0, p = a, end = a + 2 * n; p < end; p += 2) {
    const cp = s.codePointAt(i)!, w = cp > 0xffff ? 2 : 1;
    h[p] = chars ? hp.runtimeAtom(s.slice(i, i + w)) : (cp << 3) | INT;
    h[p + 1] = p + 2 < end ? ((p + 2) << 3) | LIS : tail;
    i += w;
  }
  return (a << 3) | LIS;
}

/** The answer form a call registered with `native` gives: true or false, a goal cell to run, or null for the bridge. */
type Native = (name: string, arity: number, f: () => boolean | number | null) => void;

/**
 * Install the text builtins on `cm` through `native`, which leaves a null answer to the object builtin
 * (builtins.ts installTermBuiltins detOr).
 */
export function installTextBuiltins(cm: CellMachine, native: Native): void {
  const hp = cm.hp, A = cm.A;
  const unbound = (c0: number): boolean => {
    const c = hp.deref(c0);
    return (c & 7) === REF || (c & 7) === ATV;
  };
  // textArg (builtins.ts): any text, a code or char list included.
  const text = (c: number): string | null => textOfCell(hp, c);
  // atomicText: a list, a compound or [] is the object builtin's type error.
  const atomic = (c0: number): string | null => {
    const c = hp.deref(c0);
    return (c & 7) === LIS || (c & 7) === STR || c === hp.NIL ? null : textOfCell(hp, c);
  };
  const atom = (s: string): number => hp.runtimeAtom(s);
  const str = (s: string): number => hp.box(new Str(s));
  const codes = (s: string): number => textListCell(hp, s, false, hp.NIL);
  const chars = (s: string): number => textListCell(hp, s, true, hp.NIL);
  // number_codes/2's parse (str_number with leading layout skipped); text that is no number is its syntax error.
  const number = (s: string): number | null => {
    const v = parseNumber(s, true);
    if (v === null) return null;
    return v instanceof Float ? hp.box(v) : hp.int(v as number | bigint);
  };
  /**
   * Name(+X, ?Y): Y unifies with `make` of `read`'s text of X; Name(-X, +Y): X with `back` of `readBack`'s text of Y.
   * Each reader and builder answers as the object builtin's does; null hands the call to it.
   */
  const convert = (name: string, read: (c: number) => string | null, make: (s: string) => number, readBack: (c: number) => string | null, back: (s: string) => number | null): void =>
    native(name, 2, () => {
      if (!unbound(A[0]!)) {
        const t = read(A[0]!);
        return t === null ? null : hp.unify(A[1]!, make(t));
      }
      const t = readBack(A[1]!);
      if (t === null) return null;
      const x = back(t);
      return x === null ? null : hp.unify(A[0]!, x);
    });
  convert("atom_codes", atomic, codes, text, atom);
  convert("atom_chars", atomic, chars, text, atom);
  convert("string_codes", text, codes, text, str);
  convert("string_chars", text, chars, text, str);
  convert("number_codes", atomic, codes, text, number);
  convert("number_chars", atomic, chars, text, number);
  convert("atom_string", text, str, text, atom);
  convert("string_to_atom", text, atom, atomic, str);
  // split_string(+String, +SepChars, +PadChars, -SubStrings): the fields as strings, in one block of list cells.
  native("split_string", 4, () => {
    const s = text(A[0]!), sep = text(A[1]!), pad = text(A[2]!);
    if (s === null || sep === null || pad === null) return null;
    const fields = splitFields(s, sep, pad);
    const a = hp.alloc(2 * fields.length), h = hp.h;
    for (let i = 0; i < fields.length; i++) {
      h[a + 2 * i] = str(fields[i]!);
      h[a + 2 * i + 1] = i + 1 < fields.length ? ((a + 2 * i + 2) << 3) | LIS : hp.NIL;
    }
    return hp.unify(A[3]!, (a << 3) | LIS);
  });
}
