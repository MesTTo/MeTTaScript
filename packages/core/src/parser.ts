// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// S-expression parser and printer for the HE MeTTa grammar.
// Grammar: a program is atoms optionally prefixed by `!`. A word starting with `$` is a
// variable; `"..."` is a grounded String; `;` starts a line comment; words are run through
// the tokenizer and fall back to Symbol. `format` is the inverse printer.
import { type Atom, sym, variable, expr, gstr, isExpr, isVar, isSym, isGnd } from "./atom";
import { type Tokenizer } from "./tokenizer";

export interface TopAtom {
  readonly atom: Atom;
  readonly bang: boolean;
}

export const isWs = (c: string): boolean => /\s/.test(c);
export const isDelim = (c: string): boolean =>
  c === "(" || c === ")" || c === '"' || c === ";" || isWs(c);
export const isWordBodyDelim = (c: string, word: string): boolean => {
  if (c === "(" || c === ")" || isWs(c)) return true;
  if (c === ";") return !word.startsWith("$");
  if (c === '"') return word.length === 0;
  return false;
};

/** Top-level `!` dispatches evaluation only when it is the exact `!` token. A word that merely begins with
 *  `!`, such as `!foo` or `!!foo`, is a symbol. */
export function isBangQueryPrefixAt(s: string, pos: number): boolean {
  if (s[pos] !== "!") return false;
  const next = s[pos + 1];
  return next === undefined || next === "(" || next === '"' || next === ";" || isWs(next);
}

/** Advance past whitespace and `;` line comments starting at `pos`; returns the new index. Shared by the
 *  plain parser (via `Cursor`) and the spanned CST parser, so the two cannot disagree on trivia. */
export function skipTrivia(s: string, pos: number): number {
  while (pos < s.length) {
    const c = s[pos]!;
    if (isWs(c)) {
      pos++;
      continue;
    }
    if (c === ";") {
      while (pos < s.length && s[pos] !== "\n") pos++;
      continue;
    }
    break;
  }
  return pos;
}

class Cursor {
  pos = 0;
  constructor(
    readonly s: string,
    readonly tk: Tokenizer,
  ) {}
  done(): boolean {
    return this.pos >= this.s.length;
  }
  peek(): string {
    return this.s[this.pos] as string;
  }
  skipTrivia(): void {
    this.pos = skipTrivia(this.s, this.pos);
  }
}

/** Read a `"..."` string literal starting at the opening quote index `start`. Returns the grounded String
 *  atom, the index just past the closing quote (or end-of-input when unterminated), and whether a closing
 *  quote was found. Inverse of `format`'s JSON.stringify output. Shared by the plain parser (which throws on
 *  `terminated === false`) and the recovering spanned CST parser (which records a diagnostic instead). */
export function readStringAt(
  s: string,
  start: number,
): { atom: Atom; end: number; terminated: boolean } {
  let pos = start + 1; // opening quote
  let out = "";
  while (pos < s.length && s[pos] !== '"') {
    if (s[pos] === "\\" && pos + 1 < s.length) {
      const next = s[pos + 1] as string;
      // `\uXXXX` (a 4-hex-digit code unit, the form JSON.stringify emits for control characters).
      if (next === "u" && pos + 6 <= s.length) {
        const hex = s.slice(pos + 2, pos + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 6;
          continue;
        }
      }
      // The single-letter escapes JSON.stringify emits; for `"`, `\`, `/` and anything else `next` is the
      // literal character. This keeps readStringAt the inverse of format (which prints via JSON.stringify).
      out +=
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next;
      pos += 2;
      continue;
    }
    out += s[pos];
    pos++;
  }
  const terminated = pos < s.length; // stopped on a closing quote, not end-of-input
  return { atom: gstr(out), end: terminated ? pos + 1 : pos, terminated };
}

function readString(c: Cursor): Atom {
  const { atom, end, terminated } = readStringAt(c.s, c.pos);
  if (!terminated) throw new Error("unterminated string literal in MeTTa source");
  c.pos = end;
  return atom;
}

// Bound on expression nesting, so deliberately deep input cannot overflow the recursive walkers.
export const MAX_DEPTH = 4096;

function readWord(c: Cursor): string {
  let out = "";
  while (!c.done() && !isWordBodyDelim(c.peek(), out)) {
    out += c.peek();
    c.pos++;
  }
  return out;
}

/** Turn a bare word (already extracted, no delimiters) into its atom: a `$`-word is a variable, otherwise
 *  the tokenizer decides, falling back to a Symbol. Shared by the plain and spanned parsers. */
export function leafAtom(word: string, tk: Tokenizer): Atom {
  if (word.startsWith("$")) return variable(word.slice(1));
  return tk.tokenize(word) ?? sym(word);
}

function readAtom(c: Cursor, depth = 0): Atom {
  c.skipTrivia();
  const ch = c.peek();
  if (ch === ")") throw new Error("Unexpected right bracket");
  if (ch === "(") {
    if (depth >= MAX_DEPTH) throw new Error("MeTTa expression nesting too deep");
    c.pos++;
    const items: Atom[] = [];
    for (;;) {
      c.skipTrivia();
      if (c.done()) throw new Error("unbalanced '(' in MeTTa source");
      if (c.peek() === ")") {
        c.pos++;
        break;
      }
      items.push(readAtom(c, depth + 1));
    }
    return expr(items);
  }
  if (ch === '"') return readString(c);
  const word = readWord(c);
  return leafAtom(word, c.tk);
}

// Read one top-level atom from the cursor: an optional leading `!` sets the bang flag. The cursor must
// already be positioned at the atom (the caller skips leading trivia and checks for end-of-input).
function readTop(c: Cursor): TopAtom {
  let bang = false;
  if (isBangQueryPrefixAt(c.s, c.pos)) {
    bang = true;
    c.pos++;
    c.skipTrivia();
  }
  return { atom: readAtom(c), bang };
}

/** Parse the first top-level atom (with its `!`-flag), or undefined if the source is blank. */
function parseTop(src: string, tk: Tokenizer): TopAtom | undefined {
  const c = new Cursor(src, tk);
  c.skipTrivia();
  return c.done() ? undefined : readTop(c);
}

export function parse(src: string, tk: Tokenizer): Atom | undefined {
  return parseTop(src, tk)?.atom;
}

/** Parse a whole program into its sequence of top-level atoms. */
export function parseAll(src: string, tk: Tokenizer): TopAtom[] {
  const c = new Cursor(src, tk);
  const out: TopAtom[] = [];
  for (;;) {
    c.skipTrivia();
    if (c.done()) break;
    out.push(readTop(c));
  }
  return out;
}

/** Print an atom back to MeTTa source (inverse of parse for normalized input). */
export function format(a: Atom): string {
  if (isExpr(a)) return "(" + a.items.map(format).join(" ") + ")";
  if (isVar(a)) return "$" + a.name;
  if (isSym(a)) return a.name;
  if (isGnd(a)) {
    const v = a.value;
    switch (v.g) {
      case "int":
        return String(v.n);
      case "float":
        return Number.isInteger(v.n) ? v.n.toFixed(1) : String(v.n);
      case "str":
        return JSON.stringify(v.s);
      case "bool":
        return v.b ? "True" : "False";
      case "unit":
        return "()";
      case "error":
        return v.msg;
      case "ext":
        return v.id;
    }
  }
  return "?";
}
