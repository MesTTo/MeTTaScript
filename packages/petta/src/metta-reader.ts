// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: PeTTa's MeTTa reader, ported from src/parser.pl (sread and its sexpr DCG) and src/filereader.pl
// (strip and top_forms): comments removed outside strings, a file split into balanced top-level forms and !
// runnables with their line numbers, and each form read into a Prolog term where an expression is a list,
// True and False are true and false, numbers follow dcg/basics number//1, and $-variables are scoped per form.
// am[implements a-pe-parse-print]

import { parseNumber } from "./builtins";
import { NIL, PrologError, Str, mkList, mkStruct, mkVar, type Term, type Var } from "./terms";

export interface TopForm {
  readonly kind: "form" | "runnable";
  readonly text: string;
  readonly line: number;
}

function syntaxError(msg: string): PrologError {
  return new PrologError(mkStruct("error", mkStruct("syntax_error", msg), "none"));
}

/** filereader.pl strip/3: drop ';' comments outside strings, together with the newline that ends them. */
export function stripComments(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && inStr && i + 1 < s.length) {
      out += c + s[i + 1]!;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      out += c;
      continue;
    }
    if (c === "\n") {
      out += c;
      continue;
    }
    if (c === ";" && !inStr) {
      const nl = s.indexOf("\n", i + 1);
      if (nl < 0) return out;
      i = nl;
      continue;
    }
    out += c;
  }
  return out;
}

const isBlank = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/** filereader.pl top_forms/2: balanced (...) and !(...) forms with the line each starts on. */
export function topForms(text: string): TopForm[] {
  const s = stripComments(text);
  const forms: TopForm[] = [];
  let i = 0;
  let line = 1;
  for (;;) {
    while (i < s.length && isBlank(s[i])) {
      if (s[i] === "\n") line++;
      i++;
    }
    if (i >= s.length) return forms;
    let kind: "form" | "runnable" = "form";
    if (s[i] === "!") {
      kind = "runnable";
      i++;
    }
    if (s[i] !== "(") {
      const nl = s.indexOf("\n", i);
      throw syntaxError(`expected '(' or '!(', line ${line}:\n${s.slice(i, nl < 0 ? s.length : nl)}`);
    }
    const start = i;
    const startLine = line;
    let depth = 0;
    let inStr = false;
    let closed = false;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (inStr && c === "\\") {
        i++;
        if (s[i] === "\n") line++;
        continue;
      }
      if (c === "\n") line++;
      if (c === '"') inStr = !inStr;
      else if (!inStr) {
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      if (depth === 0 && !inStr) {
        i++;
        closed = true;
        break;
      }
    }
    if (!closed) {
      const nl = s.indexOf("\n", start);
      throw syntaxError(`missing ')', starting at line ${startLine}:\n${s.slice(start, nl < 0 ? s.length : nl)}`);
    }
    forms.push({ kind, text: s.slice(start, i), line: startLine });
  }
}

/**
 * parser.pl sread/2: read one S-expression. The alternatives are tried in sexpr's order: a string literal,
 * a parenthesised sequence, a number followed by a delimiter or the end, a $variable, an atom.
 */
export function sread(text: string): Term {
  const r = new SReader(text);
  const t = r.sexpr();
  if (t === null || r.pos < text.length) throw syntaxError(`Parse error in form: ${text}`);
  return t;
}

const DELIM = " \t\r\n()";

class SReader {
  pos = 0;
  private readonly vars = new Map<string, Var>();
  constructor(private readonly s: string) {}

  private blanks(): void {
    while (this.pos < this.s.length && isBlank(this.s[this.pos])) this.pos++;
  }

  /** The longest run of characters without whitespace or parentheses (dcg string_without). */
  private token(): string {
    let j = this.pos;
    while (j < this.s.length && !DELIM.includes(this.s[j]!)) j++;
    return this.s.slice(this.pos, j);
  }

  sexpr(): Term | null {
    const save = this.pos;
    this.blanks();
    const s = this.s;
    // string literal
    if (s[this.pos] === '"') {
      const str = this.stringLit();
      if (str !== null) {
        this.blanks();
        return new Str(str);
      }
    }
    this.pos = save;
    this.blanks();
    if (s[this.pos] === "(") {
      this.pos++;
      this.blanks();
      const items: Term[] = [];
      for (;;) {
        const before = this.pos;
        const x = this.sexpr();
        if (x === null) {
          this.pos = before;
          break;
        }
        items.push(x);
        this.blanks();
      }
      this.blanks();
      if (s[this.pos] === ")") {
        this.pos++;
        this.blanks();
        return items.length === 0 ? NIL : mkList(items);
      }
      this.pos = save;
      return null;
    }
    if (s[this.pos] === ")" || this.pos >= s.length) {
      this.pos = save;
      return null;
    }
    // number (dcg/basics number//1) followed by a delimiter or the end of input
    const num = this.number();
    if (num !== null) {
      this.blanks();
      return num;
    }
    // $variable
    if (s[this.pos] === "$") {
      this.pos++;
      const tok = this.token();
      if (tok !== "") {
        this.pos += tok.length;
        this.blanks();
        if (tok === "_") return mkVar();
        let v = this.vars.get(tok);
        if (v === undefined) {
          v = mkVar();
          this.vars.set(tok, v);
        }
        return v;
      }
      this.pos--;
    }
    // atom
    const tok = this.token();
    if (tok === "") {
      this.pos = save;
      return null;
    }
    this.pos += tok.length;
    this.blanks();
    if (tok.startsWith('"')) {
      if (tok.length >= 2 && tok.endsWith('"')) return new Str(tok.slice(1, -1));
      this.pos = save;
      return null;
    }
    if (tok === "True") return "true";
    if (tok === "False") return "false";
    return tok;
  }

  /** "..." with \n, \t, \r escapes and \X for any other X. Null if unterminated. */
  private stringLit(): string | null {
    const s = this.s;
    let j = this.pos + 1;
    let out = "";
    while (j < s.length) {
      const c = s[j]!;
      if (c === '"') {
        this.pos = j + 1;
        return out;
      }
      if (c === "\\") {
        if (j + 1 >= s.length) return null;
        const x = s[j + 1]!;
        out += x === "n" ? "\n" : x === "t" ? "\t" : x === "r" ? "\r" : x;
        j += 2;
        continue;
      }
      out += c;
      j++;
    }
    return null;
  }

  private number(): Term | null {
    const s = this.s;
    let j = this.pos;
    if (s[j] === "-" || s[j] === "+") j++;
    const d0 = j;
    while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
    if (j === d0) return null;
    if (s[j] === "." && s[j + 1] !== undefined && s[j + 1]! >= "0" && s[j + 1]! <= "9") {
      j++;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
    }
    if (s[j] === "e" || s[j] === "E") {
      let k = j + 1;
      if (s[k] === "-" || s[k] === "+") k++;
      const e0 = k;
      while (k < s.length && s[k]! >= "0" && s[k]! <= "9") k++;
      if (k > e0) j = k;
    }
    if (j < s.length && !DELIM.includes(s[j]!)) return null;
    const txt = s.slice(this.pos, j);
    const n = parseNumber(txt.startsWith("+") ? txt.slice(1) : txt);
    if (n === null) return null;
    this.pos = j;
    return n;
  }
}
